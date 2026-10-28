import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export type UpdateCapabilityPurpose = "health" | "promote";
export type UpdateCapabilityStage = "validate" | "gated";
export type UpdateCapabilityMethod = "GET" | "POST";

export interface UpdateCapabilityClaims {
  attemptId: string;
  fence: number;
  purpose: UpdateCapabilityPurpose;
  method: UpdateCapabilityMethod;
  stage: UpdateCapabilityStage;
  expiresAt: number;
}

export interface ExpectedUpdateCapability {
  attemptId: string;
  fence: number;
  purpose: UpdateCapabilityPurpose;
  method: UpdateCapabilityMethod;
  stage: UpdateCapabilityStage;
  now?: number;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

const DOMAIN = "filestation-update-capability-v1\0";
const RECEIPT_DOMAIN = "filestation-update-ready-receipt-v1\0";
const INHERITED_SCHEMA = 1;
const MAX_INHERITED_BYTES = 4096;
const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PURPOSES = new Set<UpdateCapabilityPurpose>(["health", "promote"]);
const STAGES = new Set<UpdateCapabilityStage>(["validate", "gated"]);
const METHODS = new Set<UpdateCapabilityMethod>(["GET", "POST"]);

function canonical(value: JsonValue): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical value is not finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new Error("canonical value is not JSON");
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

function validClaims(value: unknown): value is UpdateCapabilityClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  return (
    typeof claims.attemptId === "string" &&
    ATTEMPT_ID.test(claims.attemptId) &&
    Number.isSafeInteger(claims.fence) &&
    (claims.fence as number) >= 1 &&
    PURPOSES.has(claims.purpose as UpdateCapabilityPurpose) &&
    METHODS.has(claims.method as UpdateCapabilityMethod) &&
    STAGES.has(claims.stage as UpdateCapabilityStage) &&
    Number.isSafeInteger(claims.expiresAt) &&
    (claims.expiresAt as number) > 0
  );
}

function validateKey(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new Error("update capability key must contain exactly 32 bytes");
  }
  return Buffer.from(key);
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export class UpdateCapabilityAuthority {
  readonly #key: Buffer;

  constructor(key: Uint8Array = randomBytes(32)) {
    this.#key = validateKey(key);
  }

  issue(input: UpdateCapabilityClaims): string {
    if (!validClaims(input)) throw new Error("update capability claims are invalid");
    const claims: UpdateCapabilityClaims = {
      attemptId: input.attemptId,
      fence: input.fence,
      purpose: input.purpose,
      method: input.method,
      stage: input.stage,
      expiresAt: input.expiresAt,
    };
    const encoded = Buffer.from(canonical(claims as unknown as JsonValue))
      .toString("base64url");
    return `${encoded}.${this.sign(DOMAIN, encoded).toString("base64url")}`;
  }

  verify(
    token: string,
    expected: ExpectedUpdateCapability,
  ): UpdateCapabilityClaims | null {
    if (typeof token !== "string" || token.length > 4096) return null;
    const separator = token.indexOf(".");
    if (separator <= 0 || separator !== token.lastIndexOf(".")) return null;
    const encoded = token.slice(0, separator);
    const supplied = token.slice(separator + 1);
    let signature: Buffer;
    try {
      signature = Buffer.from(supplied, "base64url");
    } catch {
      return null;
    }
    if (signature.length !== 32) return null;
    // Authentication is evaluated even when a claim is later found to differ.
    const authenticated = constantTimeEqual(
      this.sign(DOMAIN, encoded),
      signature,
    );
    if (!authenticated) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      );
    } catch {
      return null;
    }
    if (!validClaims(parsed)) return null;
    const claims = parsed;
    if (canonical(claims as unknown as JsonValue) !==
      Buffer.from(encoded, "base64url").toString("utf8")) {
      return null;
    }
    const now = expected.now ?? Date.now();
    if (
      !Number.isSafeInteger(now) ||
      claims.expiresAt <= now ||
      claims.attemptId !== expected.attemptId ||
      claims.fence !== expected.fence ||
      claims.purpose !== expected.purpose ||
      claims.method !== expected.method ||
      claims.stage !== expected.stage
    ) {
      return null;
    }
    return claims;
  }

  receipt(payload: Record<string, JsonValue>): string {
    const encoded = canonical(payload as JsonValue);
    return this.sign(RECEIPT_DOMAIN, encoded).toString("base64url");
  }

  verifyReceipt(
    receipt: string,
    payload: Record<string, JsonValue>,
  ): boolean {
    if (typeof receipt !== "string" || receipt.length > 4096) return false;
    let supplied: Buffer;
    try {
      supplied = Buffer.from(receipt, "base64url");
    } catch {
      return false;
    }
    if (supplied.length !== 32) return false;
    return constantTimeEqual(
      this.sign(RECEIPT_DOMAIN, canonical(payload as JsonValue)),
      supplied,
    );
  }

  /** Explicit, bounded handoff to a same-account anonymous pipe. */
  encodeInherited(): Buffer {
    return Buffer.from(
      `${JSON.stringify({
        schemaVersion: INHERITED_SCHEMA,
        key: this.#key.toString("base64url"),
      })}\n`,
      "utf8",
    );
  }

  private sign(domain: string, value: string): Buffer {
    return createHmac("sha256", this.#key)
      .update(domain, "utf8")
      .update(value, "utf8")
      .digest();
  }
}

export function encodeInheritedCapability(
  authority: UpdateCapabilityAuthority,
): Buffer {
  const encoded = authority.encodeInherited();
  if (encoded.length > MAX_INHERITED_BYTES) {
    throw new Error("inherited capability exceeds its bounded size");
  }
  return encoded;
}

export function decodeInheritedCapability(bytes: Buffer): UpdateCapabilityAuthority {
  if (!Buffer.isBuffer(bytes)) throw new Error("inherited capability is invalid");
  if (bytes.length === 0 || bytes.length > MAX_INHERITED_BYTES) {
    throw new Error("inherited capability size is not bounded");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("inherited capability is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("inherited capability envelope is invalid");
  }
  const envelope = parsed as Record<string, unknown>;
  if (
    envelope.schemaVersion !== INHERITED_SCHEMA ||
    typeof envelope.key !== "string" ||
    envelope.key.length > 128
  ) {
    throw new Error("inherited capability envelope is invalid");
  }
  let key: Buffer;
  try {
    key = Buffer.from(envelope.key, "base64url");
  } catch {
    throw new Error("inherited capability key is invalid");
  }
  try {
    return new UpdateCapabilityAuthority(key);
  } finally {
    key.fill(0);
  }
}

export async function readInheritedCapability(
  source: AsyncIterable<Uint8Array>,
): Promise<UpdateCapabilityAuthority> {
  return (await readInheritedEnvelope(source)).authority;
}

export async function readInheritedEnvelope(source: AsyncIterable<Uint8Array>): Promise<{authority: UpdateCapabilityAuthority; runtime: NodeJS.ProcessEnv; launch?: Record<string, JsonValue>}> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of source) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_INHERITED_BYTES) {
      throw new Error("inherited capability exceeds its bounded size");
    }
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks, total);
  try {
    const authority = decodeInheritedCapability(bytes);
    const parsed = JSON.parse(bytes.toString('utf8'));
    const runtime: NodeJS.ProcessEnv = {};
    const allowed = new Set(['NODE_ENV', 'JWT_SECRET', 'FILESTATION_PORT', 'FILESTATION_HOST', 'FILESTATION_DB_PATH', 'FILESTATION_STORAGE_PATH', 'FILESTATION_TEMP_PATH', 'FILESTATION_SERVE_STATIC', 'FILESTATION_WEB_URL', 'FILESTATION_WEB_DIST', 'FILESTATION_CORS_ORIGINS', 'FILESTATION_CONTAINER', 'FILESTATION_DEPLOYMENT_MODE']);
    if (parsed.runtime !== undefined) {
      if (!parsed.runtime || typeof parsed.runtime !== 'object' || Array.isArray(parsed.runtime)) throw new Error('invalid inherited runtime');
      for (const [key,value] of Object.entries(parsed.runtime)) {
        if (!allowed.has(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('invalid inherited runtime key');
        runtime[key] = value;
      }
    }
    return {authority,runtime,...(parsed.launch ? {launch:parsed.launch} : {})};
  } finally { bytes.fill(0); for(const chunk of chunks) chunk.fill(0); }
}

export async function writeInheritedCapability(
  authority: UpdateCapabilityAuthority,
  write: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  const encoded = encodeInheritedCapability(authority);
  try {
    await write(encoded);
  } finally {
    encoded.fill(0);
  }
}
