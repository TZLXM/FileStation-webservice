import type { RecoveryLockHandle } from "./update-lock";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  DurableFileSystem,
  NodeDurableFileSystem,
} from "../platform/durable-fs";

export type AttemptPhase =
  | "PREPARED"
  | "MAINTENANCE"
  | "SNAPSHOT_READY"
  | "HANDOFF_READY"
  | "OLD_STOPPED"
  | "SWITCH_INTENT"
  | "CURRENT_SWITCHED"
  | "MIGRATING"
  | "MIGRATED_VERIFIED"
  | "READY_TO_COMMIT"
  | "COMMITTED"
  | "ROLLBACK_INTENT"
  | "ROLLED_BACK"
  | "FAILED"
  | "ABORTED";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JournalOwner {
  bootIdentity: string;
  pid: number;
  processCreatedAt: string;
  heartbeatAt: string;
  /** Hash only; the inherited handoff capability itself never enters the journal. */
  handoffIdentityHash?: string;
}

export interface AttemptContext {
  attemptId: string;
  fence: number;
  currentVersion: string;
  targetVersion: string;
  previousVersion?: string;
  backupId?: string;
  phase: AttemptPhase;
  owner: JournalOwner;
}

export type JournalRecordKind = "attempt" | "intent" | "completion";

export interface JournalRecord {
  schemaVersion: 1;
  seq: number;
  id: string;
  kind: JournalRecordKind;
  at: string;
  context: AttemptContext;
  action?: string;
  phase: AttemptPhase;
  intentId?: string;
  payload?: JsonValue;
  result?: JsonValue;
  checksum: string;
}

export interface PendingJournalIntent {
  intentId: string;
  seq: number;
  at: string;
  action: string;
  phase: AttemptPhase;
  payload?: JsonValue;
}

export interface AttemptJournalSnapshot {
  initialized: boolean;
  attemptId?: string;
  fence: number;
  phase?: AttemptPhase;
  owner?: JournalOwner;
  currentVersion?: string;
  targetVersion?: string;
  previousVersion?: string;
  backupId?: string;
  updatedAt?: string;
  sequence: number;
  pending: PendingJournalIntent | null;
  records: JournalRecord[];
}

export interface PublicUpdateStatus {
  schemaVersion: 1;
  attemptId: string;
  fence: number;
  phase: AttemptPhase;
  currentVersion: string;
  targetVersion: string;
  previousVersion?: string;
  backupId?: string;
  updatedAt: string;
}

export interface AttemptJournalOptions {
  fs?: DurableFileSystem;
  now?: () => Date;
  id?: () => string;
}

export interface AppendIntentInput {
  attemptId: string;
  fence: number;
  action: string;
  phase: AttemptPhase;
  payload?: JsonValue;
}

export interface AppendCompletionInput {
  attemptId: string;
  fence: number;
  intentId: string;
  phase: AttemptPhase;
  result?: JsonValue;
  nextContext?: AttemptContext;
}

export class JournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalError";
  }
}

export class JournalCorruptError extends JournalError {
  constructor(message: string) {
    super(message);
    this.name = "JournalCorruptError";
  }
}

export class JournalFenceError extends JournalError {
  constructor(message: string) {
    super(message);
    this.name = "JournalFenceError";
  }
}

const JOURNAL_FILENAME = "update-attempt.journal";
const STATUS_FILENAME = "update-status.json";
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const PHASES = new Set<AttemptPhase>([
  "PREPARED",
  "MAINTENANCE",
  "SNAPSHOT_READY",
  "HANDOFF_READY",
  "OLD_STOPPED",
  "SWITCH_INTENT",
  "CURRENT_SWITCHED",
  "MIGRATING",
  "MIGRATED_VERIFIED",
  "READY_TO_COMMIT",
  "COMMITTED",
  "ROLLBACK_INTENT",
  "ROLLED_BACK",
  "FAILED",
  "ABORTED",
]);
const SECRET_KEY = /(authorization|capability|credential|jwt|password|recovery[_-]?code|secret|token)/i;

function cloneJson(value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function assertJson(value: JsonValue | undefined, label: string): void {
  if (value === undefined) return;
  const visit = (candidate: JsonValue, depth: number): void => {
    if (depth > 64) throw new JournalError(`${label} is too deeply nested`);
    if (candidate === null) return;
    if (typeof candidate === "string") {
      if (candidate.length > 64 * 1024)
        throw new JournalError(`${label} string is too large`);
      return;
    }
    if (
      typeof candidate === "number" ||
      typeof candidate === "boolean"
    ) {
      if (typeof candidate === "number" && !Number.isFinite(candidate))
        throw new JournalError(`${label} number must be finite`);
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    if (!candidate || typeof candidate !== "object")
      throw new JournalError(`${label} is not JSON`);
    for (const [key, item] of Object.entries(candidate)) {
      if (SECRET_KEY.test(key))
        throw new JournalError(`${label} contains a forbidden credential field`);
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
}

function checksum(record: Omit<JournalRecord, "checksum">): string {
  return createHash("sha256")
    .update(JSON.stringify(record), "utf8")
    .digest("hex");
}

function makeRecord(
  base: Omit<JournalRecord, "checksum">,
): JournalRecord {
  return { ...base, checksum: checksum(base) };
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function validateContext(value: unknown): asserts value is AttemptContext {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new JournalCorruptError("journal context is invalid");
  const context = value as Record<string, unknown>;
  if (
    typeof context.attemptId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(context.attemptId) ||
    !Number.isSafeInteger(context.fence) ||
    (context.fence as number) < 1 ||
    typeof context.currentVersion !== "string" ||
    typeof context.targetVersion !== "string" ||
    !PHASES.has(context.phase as AttemptPhase) ||
    !context.owner ||
    typeof context.owner !== "object"
  )
    throw new JournalCorruptError("journal context is invalid");
  const owner = context.owner as Record<string, unknown>;
  if (
    typeof owner.bootIdentity !== "string" ||
    owner.bootIdentity.length === 0 ||
    !Number.isSafeInteger(owner.pid) ||
    (owner.pid as number) < 1 ||
    typeof owner.processCreatedAt !== "string" ||
    owner.processCreatedAt.length === 0 ||
    !isIsoDate(owner.heartbeatAt) ||
    (owner.handoffIdentityHash !== undefined &&
      (typeof owner.handoffIdentityHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(owner.handoffIdentityHash)))
  )
    throw new JournalCorruptError("journal owner identity is invalid");
}

function decodeRecord(line: string, expectedSequence: number): JournalRecord {
  if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES)
    throw new JournalCorruptError("journal record exceeds size limit");
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new JournalCorruptError("journal record is not JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new JournalCorruptError("journal record is not an object");
  const record = raw as Record<string, unknown>;
  if (record.seq !== expectedSequence)
    throw new JournalCorruptError(
      `journal sequence ${String(record.seq)} does not equal expected ${expectedSequence}`,
    );
  if (
    record.schemaVersion !== 1 ||
    !Number.isSafeInteger(record.seq) ||
    typeof record.id !== "string" ||
    !/^[A-Za-z0-9-]{8,128}$/.test(record.id) ||
    !["attempt", "intent", "completion"].includes(String(record.kind)) ||
    !isIsoDate(record.at) ||
    !PHASES.has(record.phase as AttemptPhase) ||
    typeof record.checksum !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.checksum)
  )
    throw new JournalCorruptError("journal record envelope is invalid");
  validateContext(record.context);
  if (record.kind === "intent") {
    if (
      typeof record.action !== "string" ||
      !/^[a-z][a-z0-9-]{1,63}$/.test(record.action)
    )
      throw new JournalCorruptError("journal intent action is invalid");
    assertJson(record.payload as JsonValue | undefined, "journal payload");
  } else if (record.action !== undefined || record.payload !== undefined) {
    throw new JournalCorruptError("non-intent journal record has intent fields");
  }
  if (record.kind === "completion") {
    if (typeof record.intentId !== "string")
      throw new JournalCorruptError("journal completion lacks intent id");
    assertJson(record.result as JsonValue | undefined, "journal result");
  } else if (record.intentId !== undefined || record.result !== undefined) {
    throw new JournalCorruptError("non-completion journal record has completion fields");
  }
  const { checksum: actual, ...withoutChecksum } = record;
  if (checksum(withoutChecksum as Omit<JournalRecord, "checksum">) !== actual)
    throw new JournalCorruptError(
      `journal checksum mismatch at sequence ${expectedSequence}`,
    );
  return record as unknown as JournalRecord;
}

const TERMINAL_PHASES = new Set<AttemptPhase>([
  "COMMITTED",
  "ROLLED_BACK",
  "FAILED",
  "ABORTED",
]);

function summarizeAttempt(records: JournalRecord[]): AttemptJournalSnapshot {
  if (!records.length)
    return {
      initialized: false,
      fence: 0,
      sequence: 0,
      pending: null,
      records: [],
    };
  const first = records[0];
  if (first.kind !== "attempt")
    throw new JournalCorruptError("journal must begin with an attempt record");
  const intents = new Map<
    string,
    { record: JournalRecord; completed: boolean }
  >();
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.context.attemptId !== first.context.attemptId)
      throw new JournalCorruptError("journal mixes attempt ids");
    if (index > 0 && record.kind === "attempt")
      throw new JournalCorruptError("journal contains a second attempt record");
    if (record.context.fence < first.context.fence)
      throw new JournalCorruptError("journal fence moved backwards");
    if (record.kind === "intent") {
      if (record.action === undefined)
        throw new JournalCorruptError("journal intent lacks action");
      intents.set(record.id, { record, completed: false });
    } else if (record.kind === "completion") {
      const intent = record.intentId
        ? intents.get(record.intentId)
        : undefined;
      if (!intent || intent.completed)
        throw new JournalCorruptError("journal completion has no open intent");
      intent.completed = true;
    }
  }
  const open = [...intents.values()].filter((entry) => !entry.completed);
  if (open.length > 2 || (open.length === 2 && open.at(-1)?.record.action !== "replace-owner"))
    throw new JournalCorruptError("journal has more than one open intent");
  const last = records[records.length - 1];
  const context = last.context;
  const pendingRecord = open.at(-1)?.record;
  return {
    initialized: true,
    attemptId: context.attemptId,
    fence: context.fence,
    phase: context.phase,
    owner: context.owner,
    currentVersion: context.currentVersion,
    targetVersion: context.targetVersion,
    previousVersion: context.previousVersion,
    backupId: context.backupId,
    updatedAt: last.at,
    sequence: last.seq,
    pending: pendingRecord
      ? {
          intentId: pendingRecord.id,
          seq: pendingRecord.seq,
          at: pendingRecord.at,
          action: pendingRecord.action as string,
          phase: pendingRecord.phase,
          payload: pendingRecord.payload,
        }
      : null,
    records,
  };
}

function summarize(records: JournalRecord[]): AttemptJournalSnapshot {
  if (!records.length)
    return {
      initialized: false,
      fence: 0,
      sequence: 0,
      pending: null,
      records: [],
    };
  const starts: number[] = [];
  for (let index = 0; index < records.length; index++) {
    if (records[index].kind === "attempt") starts.push(index);
  }
  if (!starts.length || starts[0] !== 0)
    throw new JournalCorruptError("journal must begin with an attempt record");
  let previous: AttemptJournalSnapshot | undefined;
  for (let index = 0; index < starts.length; index++) {
    const segment = records.slice(
      starts[index],
      index + 1 < starts.length ? starts[index + 1] : records.length,
    );
    const current = summarizeAttempt(segment);
    if (previous) {
      if (!previous.phase || !TERMINAL_PHASES.has(previous.phase))
        throw new JournalCorruptError(
          "a new attempt starts before the previous attempt is terminal",
        );
      if (!current.pending && current.fence <= previous.fence)
        throw new JournalCorruptError(
          "journal fence did not advance between attempts",
        );
      if (current.attemptId === previous.attemptId)
        throw new JournalCorruptError(
          "journal reuses an attempt id without reaching a new attempt record",
        );
    }
    previous = current;
  }
  return previous as AttemptJournalSnapshot;
}

function publicStatus(snapshot: AttemptJournalSnapshot): PublicUpdateStatus {
  if (
    !snapshot.initialized ||
    !snapshot.attemptId ||
    !snapshot.phase ||
    !snapshot.currentVersion ||
    !snapshot.targetVersion ||
    !snapshot.updatedAt
  )
    throw new JournalError("cannot project an uninitialized journal");
  return {
    schemaVersion: 1,
    attemptId: snapshot.attemptId,
    fence: snapshot.fence,
    phase: snapshot.phase,
    currentVersion: snapshot.currentVersion,
    targetVersion: snapshot.targetVersion,
    ...(snapshot.previousVersion
      ? { previousVersion: snapshot.previousVersion }
      : {}),
    ...(snapshot.backupId ? { backupId: snapshot.backupId } : {}),
    updatedAt: snapshot.updatedAt,
  };
}

export async function writeStatusProjection(
  root: string,
  snapshot: AttemptJournalSnapshot,
  fs: DurableFileSystem = new NodeDurableFileSystem(),
): Promise<string> {
  const filename = path.join(root, STATUS_FILENAME);
  await fs.writeAtomic(
    filename,
    Buffer.from(`${JSON.stringify(publicStatus(snapshot), null, 2)}\n`, "utf8"),
    { mode: 0o600 },
  );
  return filename;
}

export class AttemptJournal {
  private writeQueue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly root: string,
    readonly filename: string,
    private readonly fs: DurableFileSystem,
    private readonly now: () => Date,
    private readonly id: () => string,
  ) {}

  static async open(
    root: string,
    options: AttemptJournalOptions = {},
  ): Promise<AttemptJournal> {
    const fs = options.fs ?? new NodeDurableFileSystem();
    await fs.ensurePrivateDirectory(root);
    const journal = new AttemptJournal(
      root,
      path.join(root, JOURNAL_FILENAME),
      fs,
      options.now ?? (() => new Date()),
      options.id ?? randomUUID,
    );
    await journal.loadAndRepair();
    return journal;
  }

  private withWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async loadAndRepair(): Promise<JournalRecord[]> {
    if (!(await this.fs.exists(this.filename))) return [];
    const raw = await this.fs.readFile(this.filename);
    if (raw.length > MAX_JOURNAL_BYTES)
      throw new JournalCorruptError("journal exceeds size limit");
    let retained = raw;
    if (raw.length && raw[raw.length - 1] !== 0x0a) {
      const boundary = raw.lastIndexOf(0x0a);
      retained = boundary < 0 ? Buffer.alloc(0) : raw.subarray(0, boundary + 1);

    }
    const text = retained.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(retained))
      throw new JournalCorruptError("journal is not valid UTF-8");
    const lines = text.length ? text.slice(0, -1).split("\n") : [];
    const records = lines.map((line, index) => decodeRecord(line, index + 1));
    summarize(records);
    return records;
  }

  private async appendRecord(
    record: Omit<JournalRecord, "checksum">,
  ): Promise<JournalRecord> {
    const complete = makeRecord(record);
    const bytes = Buffer.from(`${JSON.stringify(complete)}\n`, "utf8");
    const existing = await this.fs.exists(this.filename) ? await this.fs.readFile(this.filename) : Buffer.alloc(0);
    if (existing.length && existing.at(-1) !== 0x0a)
      throw new JournalCorruptError("partial tail requires exclusive recovery repair");
    await this.fs.append(this.filename, bytes, { mode: 0o600, create: true });
    return complete;
  }

  async beginAttempt(input: AttemptContext): Promise<JournalRecord> {
    return this.withWrite(async () => {
      const snapshot = await this.readSnapshot();
      validateContext(input);
      if (input.fence < 1) throw new JournalFenceError("fence must be positive");
      if (snapshot.initialized) {
        if (!snapshot.phase || !TERMINAL_PHASES.has(snapshot.phase))
          throw new JournalError("journal attempt is already initialized");
        if (snapshot.pending)
          throw new JournalError("terminal journal still has a pending intent");
        if (snapshot.attemptId === input.attemptId)
          throw new JournalError("journal attempt id must be unique");
        if (input.fence <= snapshot.fence)
          throw new JournalFenceError(
            `new fence ${input.fence} must exceed ${snapshot.fence}`,
          );
      }
      return this.appendRecord({
        schemaVersion: 1,
        seq: snapshot.sequence + 1,
        id: this.id(),
        kind: "attempt",
        at: this.now().toISOString(),
        context: structuredClone(input),
        phase: input.phase,
      });
    });
  }

  async appendIntent(input: AppendIntentInput): Promise<JournalRecord> {
    return this.withWrite(async () => {
      const snapshot = await this.readSnapshot();
      this.assertWrite(snapshot, input.attemptId, input.fence);
      if (snapshot.pending && (input.action !== "replace-owner" || snapshot.pending.action === "replace-owner"))
        throw new JournalError(
          `pending intent ${snapshot.pending.intentId} must be completed first`,
        );
      if (snapshot.phase === "COMMITTED" && input.phase !== "COMMITTED")
        throw new JournalError("COMMITTED cannot transition to rollback");
      if (!PHASES.has(input.phase))
        throw new JournalError("invalid attempt phase");
      if (!/^[a-z][a-z0-9-]{1,63}$/.test(input.action))
        throw new JournalError("invalid journal action");
      assertJson(input.payload, "journal payload");
      const context = structuredClone(snapshot.records.at(-1)!.context);
      context.phase = input.phase;
      context.owner.heartbeatAt = this.now().toISOString();
      return this.appendRecord({
        schemaVersion: 1,
        seq: snapshot.sequence + 1,
        id: this.id(),
        kind: "intent",
        at: this.now().toISOString(),
        context,
        action: input.action,
        phase: input.phase,
        ...(input.payload === undefined
          ? {}
          : { payload: cloneJson(input.payload) }),
      });
    });
  }

  async appendCompletion(
    input: AppendCompletionInput,
  ): Promise<JournalRecord> {
    return this.withWrite(async () => {
      const snapshot = await this.readSnapshot();
      this.assertWrite(snapshot, input.attemptId, input.fence);
      if (
        snapshot.initialized &&
        snapshot.attemptId === input.attemptId &&
        snapshot.records.some(
          (record) =>
            record.kind === "completion" && record.intentId === input.intentId,
        )
      ) {
        return snapshot.records.find(
          (record) =>
            record.kind === "completion" && record.intentId === input.intentId,
        )!;
      }
      this.assertWrite(snapshot, input.attemptId, input.fence);
      if (!snapshot.pending || snapshot.pending.intentId !== input.intentId)
        throw new JournalError("completion does not match the pending intent");
      if (snapshot.phase === "COMMITTED" && input.phase !== "COMMITTED")
        throw new JournalError("COMMITTED cannot transition to rollback");
      assertJson(input.result, "journal result");
      const context = input.nextContext
        ? structuredClone(input.nextContext)
        : structuredClone(snapshot.records.at(-1)!.context);
      if (input.nextContext) {
        validateContext(input.nextContext);
        if (input.nextContext.attemptId !== snapshot.attemptId)
          throw new JournalFenceError("owner replacement changes the attempt id");
        const allowed =
          snapshot.pending.action === "replace-owner" &&
          input.nextContext.fence === input.fence + 1 &&
          input.nextContext.phase === snapshot.phase && input.phase === snapshot.phase;
        if (!allowed)
          throw new JournalFenceError(
            "context replacement is only valid for owner fencing",
          );
      } else {
        context.phase = input.phase;
        context.owner.heartbeatAt = this.now().toISOString();
      }
      return this.appendRecord({
        schemaVersion: 1,
        seq: snapshot.sequence + 1,
        id: this.id(),
        kind: "completion",
        at: this.now().toISOString(),
        context,
        phase: input.phase,
        intentId: input.intentId,
        ...(input.result === undefined
          ? {}
          : { result: cloneJson(input.result) }),
      });
    });
  }

  private assertWrite(
    snapshot: AttemptJournalSnapshot,
    attemptId: string,
    fence: number,
  ): void {
    if (!snapshot.initialized)
      throw new JournalError("journal attempt is not initialized");
    if (snapshot.attemptId !== attemptId)
      throw new JournalFenceError("attempt id does not own the journal");
    if (snapshot.fence !== fence)
      throw new JournalFenceError(
        `stale fence ${fence}; current fence is ${snapshot.fence}`,
      );
  }

  async repairTail(ownership: RecoveryLockHandle): Promise<void> {
    await this.withWrite(async () => {
      await ownership.assertJournalRepairAllowed();
      await this.loadAndRepair();
      if (!(await this.fs.exists(this.filename))) return;
      const raw = await this.fs.readFile(this.filename);
      if (raw.length && raw.at(-1) !== 0x0a) {
        await ownership.assertJournalRepairAllowed();
        await this.fs.truncate(this.filename, raw.lastIndexOf(0x0a) + 1);
      }
    });
  }

  async readSnapshot(): Promise<AttemptJournalSnapshot> {
    return summarize(await this.loadAndRepair());
  }

  async writeStatusProjection(
    snapshot?: AttemptJournalSnapshot,
  ): Promise<string> {
    const current = snapshot ?? (await this.readSnapshot());
    return writeStatusProjection(this.root, current, this.fs);
  }
}
