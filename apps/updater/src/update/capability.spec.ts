import {
  UpdateCapabilityAuthority,
  constantTimeEqual,
  decodeInheritedCapability,
  encodeInheritedCapability,
  readInheritedCapability,
  writeInheritedCapability,
} from "./capability";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const KEY = Buffer.alloc(32, 0x5a);

function authority(): UpdateCapabilityAuthority {
  return new UpdateCapabilityAuthority(KEY);
}

function claims(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: "attempt-capability-01",
    fence: 7,
    purpose: "health" as const,
    method: "GET" as const,
    stage: "validate" as const,
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

describe("update capability authority", () => {
  it("accepts only an unexpired capability bound to the exact request", () => {
    const capability = authority();
    const token = capability.issue(claims());

    expect(
      capability.verify(token, {
        attemptId: "attempt-capability-01",
        fence: 7,
        purpose: "health",
        method: "GET",
        stage: "validate",
        now: NOW,
      }),
    ).toEqual(claims());
  });

  it.each([
    ["attempt", { attemptId: "another-attempt" }],
    ["fence", { fence: 8 }],
    ["purpose", { purpose: "promote" }],
    ["method", { method: "POST" }],
    ["stage", { stage: "gated" }],
  ] as const)("rejects a capability with a changed %s", (_label, change) => {
    const capability = authority();
    const token = capability.issue(claims());

    expect(
      capability.verify(token, {
        attemptId: "attempt-capability-01",
        fence: 7,
        purpose: "health",
        method: "GET",
        stage: "validate",
        now: NOW,
        ...change,
      } as never),
    ).toBeNull();
  });

  it("rejects expiry and tampering without accepting non-canonical payloads", () => {
    const capability = authority();
    const token = capability.issue(claims());
    const expected = {
      attemptId: "attempt-capability-01",
      fence: 7,
      purpose: "health" as const,
      method: "GET" as const,
      stage: "validate" as const,
      now: NOW + 60_000,
    };

    expect(capability.verify(token, expected)).toBeNull();

    const [encoded, signature] = token.split(".");
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const nonCanonical = Buffer.from(
      JSON.stringify({ ...payload, padding: "not-covered" }),
    ).toString("base64url");
    expect(
      capability.verify(`${nonCanonical}.${signature}`, {
        ...expected,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("compares equal-length digests in constant time and rejects short buffers", () => {
    expect(constantTimeEqual(Buffer.alloc(32, 1), Buffer.alloc(32, 1))).toBe(
      true,
    );
    expect(constantTimeEqual(Buffer.alloc(32, 1), Buffer.alloc(32, 2))).toBe(
      false,
    );
    expect(constantTimeEqual(Buffer.alloc(2, 1), Buffer.alloc(3, 1))).toBe(
      false,
    );
  });

  it("creates a deterministic receipt for canonical readiness data", () => {
    const capability = authority();
    const left = {
      attempt_id: "attempt-capability-01",
      fence: 7,
      target_version: "0.2.5",
      migration_id: "1800000000000",
      schema_sha256: "a".repeat(64),
      health: "ok",
    };
    const right = {
      health: "ok",
      schema_sha256: "a".repeat(64),
      migration_id: "1800000000000",
      target_version: "0.2.5",
      fence: 7,
      attempt_id: "attempt-capability-01",
    };

    expect(capability.receipt(left as never)).toBe(
      authority().receipt(right as never),
    );
  });

  it("uses a bounded inherited-channel envelope without putting key material in strings", () => {
    const capability = authority();
    const encoded = encodeInheritedCapability(capability);
    expect(encoded.length).toBeLessThan(4096);
    expect(encoded.toString("utf8")).not.toContain("attempt-capability");
    expect(JSON.stringify(capability)).toBe("{}");

    const decoded = decodeInheritedCapability(encoded);
    expect(
      decoded.verify(capability.issue(claims()), {
        attemptId: "attempt-capability-01",
        fence: 7,
        purpose: "health",
        method: "GET",
        stage: "validate",
        now: NOW,
      }),
    ).not.toBeNull();

    expect(() =>
      decodeInheritedCapability(Buffer.alloc(65 * 1024, 0x20)),
    ).toThrow(/size|bounded|large/i);
  });

  it("reads an anonymous inherited stream only after a bounded complete frame", async () => {
    const source = encodeInheritedCapability(authority());
    const chunks = async function* () {
      yield source.subarray(0, 17);
      yield source.subarray(17);
    };

    const decoded = await readInheritedCapability(chunks());
    expect(decoded.verify(authority().issue(claims()), {
      attemptId: "attempt-capability-01",
      fence: 7,
      purpose: "health",
      method: "GET",
      stage: "validate",
      now: NOW,
    })).not.toBeNull();

    const oversized = async function* () {
      yield Buffer.alloc(5000, 0x20);
      yield Buffer.alloc(1, 0x20);
    };
    await expect(readInheritedCapability(oversized())).rejects.toThrow(
      /size|bounded|large/i,
    );

    const writes: Buffer[] = [];
    await writeInheritedCapability(authority(), async (chunk) => {
      writes.push(Buffer.from(chunk));
    });
    expect(decodeInheritedCapability(Buffer.concat(writes)).issue(claims())).toEqual(
      expect.any(String),
    );
  });
});
