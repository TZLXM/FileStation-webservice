import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import {
  AttemptContext,
  AttemptJournal,
  AttemptJournalSnapshot,
  JournalOwner,
  JsonValue,
} from "./attempt-journal";
import {
  BootIdentity,
  PlatformBootIdentityProvider,
  ProcessIdentityProvider,
} from "./boot-identity";
import {
  DurableFileSystem,
  NodeDurableFileSystem,
} from "../platform/durable-fs";

export type { ProcessIdentityProvider } from "./boot-identity";

import { acquireRecoveryGuard, RecoveryGuard } from "../platform/recovery-guard";

const OWNER_LOCK = "update.lock";
const RECOVERY_LOCK = "update.recovery.lock";

export interface LockOwnerInput {
  attemptId: string;
  bootIdentity: string;
  pid: number;
  processCreatedAt: string;
  heartbeatAt: string;
  handoffIdentityHash?: string;
  currentVersion: string;
  targetVersion: string;
  previousVersion?: string;
  backupId?: string;
}

export interface LockRecord {
  schemaVersion: 1;
  kind: "owner" | "recovery";
  attemptId: string;
  fence: number;
  owner: JournalOwner;
  checksum: string;
}

export interface LockOptions {
  fs?: DurableFileSystem;
  journal?: AttemptJournal;
  identityProvider?: ProcessIdentityProvider;
  servicePort?: number;
  now?: () => Date;
}

export interface TakeoverHandoffInput {
  owner: LockOwnerInput;
  handoffIdentity: string;
}

export class LockFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockFailure";
  }
}

function checksum(value: Omit<LockRecord, "checksum">): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function encode(record: Omit<LockRecord, "checksum">): Buffer {
  return Buffer.from(
    `${JSON.stringify({ ...record, checksum: checksum(record) })}\n`,
    "utf8",
  );
}

function decode(bytes: Buffer, kind: LockRecord["kind"]): LockRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new LockFailure("lock record is not valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new LockFailure("lock record is invalid");
  const value = raw as Record<string, unknown>;
  if (
    value.schemaVersion !== 1 ||
    value.kind !== kind ||
    typeof value.attemptId !== "string" ||
    !Number.isSafeInteger(value.fence) ||
    (value.fence as number) < 1 ||
    !value.owner ||
    typeof value.owner !== "object" ||
    typeof value.checksum !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.checksum)
  )
    throw new LockFailure("lock record envelope is invalid");
  const owner = value.owner as Record<string, unknown>;
  if (
    typeof owner.bootIdentity !== "string" ||
    !Number.isSafeInteger(owner.pid) ||
    (owner.pid as number) < 1 ||
    typeof owner.processCreatedAt !== "string" ||
    typeof owner.heartbeatAt !== "string" ||
    !Number.isFinite(Date.parse(owner.heartbeatAt)) ||
    (owner.handoffIdentityHash !== undefined &&
      (typeof owner.handoffIdentityHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(owner.handoffIdentityHash)))
  )
    throw new LockFailure("lock owner identity is invalid");
  const { checksum: actual, ...withoutChecksum } = value;
  if (checksum(withoutChecksum as Omit<LockRecord, "checksum">) !== actual)
    throw new LockFailure("lock record checksum mismatch");
  return value as unknown as LockRecord;
}

function hashCapability(capability: string): string {
  return createHash("sha256").update(capability, "utf8").digest("hex");
}

function sameDigest(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right))
    return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function isEexist(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EEXIST"
  );
}

function terminalAttempt(snapshot: AttemptJournalSnapshot): boolean {
  return (
    snapshot.initialized &&
    ["COMMITTED", "ROLLED_BACK", "FAILED", "ABORTED"].includes(
      snapshot.phase ?? "",
    ) &&
    snapshot.pending === null
  );
}

function validateActor(actor: LockOwnerInput): void {
  if (
    typeof actor.attemptId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(actor.attemptId) ||
    typeof actor.bootIdentity !== "string" ||
    actor.bootIdentity.length === 0 ||
    !Number.isSafeInteger(actor.pid) ||
    actor.pid < 1 ||
    typeof actor.processCreatedAt !== "string" ||
    actor.processCreatedAt.length === 0 ||
    !Number.isFinite(Date.parse(actor.heartbeatAt)) ||
    (actor.handoffIdentityHash !== undefined &&
      !/^[a-f0-9]{64}$/.test(actor.handoffIdentityHash))
  )
    throw new LockFailure("lock owner input is invalid");
}

function journalOwner(actor: LockOwnerInput): JournalOwner {
  return {
    bootIdentity: actor.bootIdentity,
    pid: actor.pid,
    processCreatedAt: actor.processCreatedAt,
    heartbeatAt: actor.heartbeatAt,
    ...(actor.handoffIdentityHash
      ? { handoffIdentityHash: actor.handoffIdentityHash }
      : {}),
  };
}

function attemptContext(
  actor: LockOwnerInput,
  fence: number,
  phase: AttemptContext["phase"],
): AttemptContext {
  return {
    attemptId: actor.attemptId,
    fence,
    currentVersion: actor.currentVersion,
    targetVersion: actor.targetVersion,
    ...(actor.previousVersion ? { previousVersion: actor.previousVersion } : {}),
    ...(actor.backupId ? { backupId: actor.backupId } : {}),
    phase,
    owner: journalOwner(actor),
  };
}

function recordMatchesContext(record: LockRecord, context: AttemptContext): boolean {
  return (
    record.attemptId === context.attemptId &&
    record.fence === context.fence &&
    record.owner.bootIdentity === context.owner.bootIdentity &&
    record.owner.pid === context.owner.pid &&
    record.owner.processCreatedAt === context.owner.processCreatedAt
  );
}

function isObject(
  value: JsonValue | undefined,
): value is { [key: string]: JsonValue } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function verifyLocalActor(
  actor: LockOwnerInput,
  provider: ProcessIdentityProvider,
): Promise<void> {
  let boot: BootIdentity;
  try {
    boot = await provider.current();
  } catch {
    throw new LockFailure("current boot identity is unavailable");
  }
  if (boot.value !== actor.bootIdentity)
    throw new LockFailure("lock owner boot identity does not match this machine");
  let alive: boolean;
  try {
    alive = await provider.isProcessAlive(
      actor.pid,
      actor.processCreatedAt,
    );
  } catch {
    throw new LockFailure("lock owner process identity cannot be verified");
  }
  if (!alive)
    throw new LockFailure("lock owner PID/creation identity is not alive");
}

export class LockHandle {
  private released = false;

  constructor(
    protected readonly root: string,
    protected readonly fs: DurableFileSystem,
    protected record: LockRecord,
  ) {}

  get fence(): number {
    return this.record.fence;
  }

  get owner(): JournalOwner {
    return structuredClone(this.record.owner);
  }

  async assertActive(): Promise<void> {
    if (this.released) throw new LockFailure("lock handle is released");
    const filename = path.join(this.root, OWNER_LOCK);
    if (!(await this.fs.exists(filename)))
      throw new LockFailure("update lock is no longer present");
    const current = decode(await this.fs.readFile(filename), "owner");
    if (
      current.attemptId !== this.record.attemptId ||
      current.fence !== this.record.fence ||
      current.owner.bootIdentity !== this.record.owner.bootIdentity ||
      current.owner.pid !== this.record.owner.pid ||
      current.owner.processCreatedAt !== this.record.owner.processCreatedAt
    )
      throw new LockFailure("lock fencing ownership has changed");
    this.record = current;
  }

  async heartbeat(at = new Date()): Promise<void> {
    await this.assertActive();
    this.record = {
      ...this.record,
      owner: {
        ...this.record.owner,
        heartbeatAt: at.toISOString(),
      },
    };
    await this.fs.writeAtomic(
      path.join(this.root, OWNER_LOCK),
      encode(this.record),
      { mode: 0o600 },
    );
  }

  async release(): Promise<void> {
    if (this.released) return;
    await this.assertActive();
    await this.fs.unlink(path.join(this.root, OWNER_LOCK));
    this.released = true;
  }
}

export class RecoveryLockHandle {
  private released = false;

  constructor(
    private readonly root: string,
    private readonly fs: DurableFileSystem,
    private readonly journal: AttemptJournal,
    private readonly provider: ProcessIdentityProvider,
    private readonly recoveryRecord: LockRecord,
    private readonly guard: RecoveryGuard,
    private readonly servicePort?: number,
  ) {}

  get fence(): number {
    return this.recoveryRecord.fence;
  }

  async assertActive(): Promise<void> {
    await this.guard.assertActive();
    if (this.released) throw new LockFailure("recovery lock is released");
    const filename = path.join(this.root, RECOVERY_LOCK);
    if (!(await this.fs.exists(filename)))
      throw new LockFailure("recovery lock is no longer present");
    const current = decode(await this.fs.readFile(filename), "recovery");
    if (
      current.attemptId !== this.recoveryRecord.attemptId ||
      current.fence !== this.recoveryRecord.fence ||
      current.owner.bootIdentity !== this.recoveryRecord.owner.bootIdentity ||
      current.owner.pid !== this.recoveryRecord.owner.pid ||
      current.owner.processCreatedAt !==
        this.recoveryRecord.owner.processCreatedAt
    )
      throw new LockFailure("recovery lock ownership has changed");
  }

  private async verifyOldOwnerStopped(
    snapshot: AttemptJournalSnapshot,
    oldRecord: LockRecord,
  ): Promise<void> {
    if (!snapshot.owner)
      throw new LockFailure("journal has no old owner identity");
    let currentBoot: BootIdentity;
    try {
      currentBoot = await this.provider.current();
    } catch {
      throw new LockFailure("current boot identity is unavailable");
    }
    if (currentBoot.value !== snapshot.owner.bootIdentity)
      throw new LockFailure("old owner boot identity cannot be verified");
    if (oldRecord.owner.bootIdentity !== snapshot.owner.bootIdentity)
      throw new LockFailure("lock and journal old owner boot identities differ");
    let alive: boolean;
    try {
      alive = await this.provider.isProcessAlive(
        snapshot.owner.pid,
        snapshot.owner.processCreatedAt,
      );
    } catch {
      throw new LockFailure("old owner process identity cannot be verified");
    }
    if (alive) throw new LockFailure("old owner process is still alive");
    if (this.servicePort !== undefined && this.provider.listeningPid) {
      const portOwner = await this.provider.listeningPid(this.servicePort);
      if (portOwner === snapshot.owner.pid)
        throw new LockFailure(
          "old owner still owns the service port; process is not proven stopped",
        );
    }
  }

  /** Destructive repair is available only after this retained recovery owner
   * proves the journal writer (and any interrupted replacement writer) stopped. */
  async assertJournalRepairAllowed(): Promise<void> {
    await this.assertActive();
    const snapshot = await this.journal.readSnapshot();
    if (!snapshot.owner || snapshot.attemptId !== this.recoveryRecord.attemptId)
      throw new LockFailure("tail repair attempt identity cannot be verified");
    const current = decode(await this.fs.readFile(path.join(this.root, OWNER_LOCK)), "owner");
    if (!recordMatchesContext(current, snapshot.records.at(-1)!.context)) {
      const payload = snapshot.pending?.payload;
      if (snapshot.pending?.action !== "replace-owner" || !isObject(payload) || !isObject(payload.nextContext) || !recordMatchesContext(current, payload.nextContext as unknown as AttemptContext))
        throw new LockFailure("tail repair owner differs from journal");
      if (await this.provider.isProcessAlive(current.owner.pid, current.owner.processCreatedAt))
        throw new LockFailure("replacement journal writer is still alive");
    }
    await this.verifyOldOwnerStopped(snapshot, current);
  }

  async repairJournalTail(): Promise<void> {
    await this.journal.repairTail(this);
  }

  async takeoverHandoff(
    input: TakeoverHandoffInput,
  ): Promise<LockHandle> {
    await this.assertActive();
    validateActor(input.owner);
    if (input.owner.pid !== this.recoveryRecord.owner.pid || input.owner.processCreatedAt !== this.recoveryRecord.owner.processCreatedAt || input.owner.bootIdentity !== this.recoveryRecord.owner.bootIdentity)
      throw new LockFailure("actor boot/process identity does not own recovery lock");
    await verifyLocalActor(input.owner, this.provider);
    const snapshot = await this.journal.readSnapshot();
    if (!snapshot.initialized || !snapshot.attemptId)
      throw new LockFailure("journal attempt is not initialized");
    if (input.owner.attemptId !== snapshot.attemptId)
      throw new LockFailure("handoff owner cannot change the attempt id");

    const lockPath = path.join(this.root, OWNER_LOCK);
    if (!(await this.fs.exists(lockPath)))
      throw new LockFailure("owner lock is missing; recovery requires review");
    const currentRecord = decode(await this.fs.readFile(lockPath), "owner");
    if (!snapshot.owner?.handoffIdentityHash)
      throw new LockFailure("journal owner has no handoff identity");
    if (
      !sameDigest(
        snapshot.owner.handoffIdentityHash,
        hashCapability(input.handoffIdentity),
      )
    )
      throw new LockFailure("handoff identity does not match");

    if (snapshot.pending?.action === "replace-owner") {
      const payload = snapshot.pending.payload;
      if (!isObject(payload) || !isObject(payload.nextContext))
        throw new LockFailure("owner replacement intent is malformed");
      const next = payload.nextContext as unknown as AttemptContext;
      const differentActor = next.owner.pid !== input.owner.pid || next.owner.processCreatedAt !== input.owner.processCreatedAt;
      if (differentActor && await this.provider.isProcessAlive(next.owner.pid, next.owner.processCreatedAt))
        throw new LockFailure("interrupted replacement owner is still alive");
      if (recordMatchesContext(currentRecord, next)) {
        await this.journal.appendCompletion({
          attemptId: snapshot.attemptId,
          fence: snapshot.fence,
          intentId: snapshot.pending.intentId,
          phase: next.phase,
          nextContext: next,
          result: { handedOff: true },
        });
        if (differentActor) return this.recoverAttempt({ ...input, expectedFence: next.fence });
        return new LockHandle(this.root, this.fs, currentRecord);
      }
      if (
        currentRecord.attemptId !== snapshot.attemptId ||
        currentRecord.fence !== snapshot.fence ||
        currentRecord.owner.bootIdentity !== snapshot.owner.bootIdentity ||
        currentRecord.owner.pid !== snapshot.owner.pid ||
        currentRecord.owner.processCreatedAt !==
          snapshot.owner.processCreatedAt
      )
        throw new LockFailure(
          "owner lock does not match the journal during owner recovery",
        );
      await this.verifyOldOwnerStopped(snapshot, currentRecord);
      await this.finishOwnerReplacement(
        snapshot.attemptId,
        snapshot.fence,
        snapshot.pending.intentId,
        next,
        await this.fs.readFile(lockPath),
      );
      if (differentActor) return this.recoverAttempt({ ...input, expectedFence: next.fence });
      return new LockHandle(this.root, this.fs, decode(await this.fs.readFile(lockPath), "owner"));
    }

    if (snapshot.pending)
      throw new LockFailure(
        `pending action ${snapshot.pending.action} must be recovered before owner handoff`,
      );
    if (snapshot.phase !== "HANDOFF_READY")
      throw new LockFailure("owner handoff requires HANDOFF_READY");
    if (
      currentRecord.attemptId !== snapshot.attemptId ||
      currentRecord.fence !== snapshot.fence ||
      currentRecord.owner.bootIdentity !== snapshot.owner.bootIdentity ||
      currentRecord.owner.pid !== snapshot.owner.pid ||
      currentRecord.owner.processCreatedAt !== snapshot.owner.processCreatedAt
    )
      throw new LockFailure("owner lock does not match the journal");
    await this.verifyOldOwnerStopped(snapshot, currentRecord);

    const nextFence = snapshot.fence + 1;
    const nextContext = attemptContext(
      input.owner,
      nextFence,
      "HANDOFF_READY",
    );
    nextContext.owner.handoffIdentityHash = snapshot.owner.handoffIdentityHash;
    const intent = await this.journal.appendIntent({
      attemptId: snapshot.attemptId,
      fence: snapshot.fence,
      action: "replace-owner",
      phase: "HANDOFF_READY",
      payload: { nextContext } as unknown as JsonValue,
    });
    await this.finishOwnerReplacement(
      snapshot.attemptId,
      snapshot.fence,
      intent.id,
      nextContext,
      await this.fs.readFile(lockPath),
    );
    return new LockHandle(
      this.root,
      this.fs,
      decode(
        await this.fs.readFile(lockPath),
        "owner",
      ),
    );
  }

  /** Authenticated recovery of an active attempt. Preserves phase and any
   * in-flight filesystem intent. COMMITTED remains COMMITTED. No rollback is
   * selected here: the orchestrator must honor the authoritative phase. */
  async recoverAttempt(input: TakeoverHandoffInput & { expectedFence: number }): Promise<LockHandle> {
    await this.assertActive();
    validateActor(input.owner);
    if (input.owner.pid !== this.recoveryRecord.owner.pid || input.owner.processCreatedAt !== this.recoveryRecord.owner.processCreatedAt || input.owner.bootIdentity !== this.recoveryRecord.owner.bootIdentity)
      throw new LockFailure("actor boot/process identity does not own recovery lock");
    await verifyLocalActor(input.owner, this.provider);
    const snapshot = await this.journal.readSnapshot();
    if (snapshot.attemptId !== input.owner.attemptId || snapshot.fence !== input.expectedFence || !snapshot.owner || !snapshot.phase)
      throw new LockFailure("recovery attempt/fence does not match");
    if (!snapshot.owner.handoffIdentityHash || !sameDigest(snapshot.owner.handoffIdentityHash, hashCapability(input.handoffIdentity)))
      throw new LockFailure("recovery identity does not match");
    if (snapshot.pending?.action === "replace-owner") return this.takeoverHandoff(input);
    const lockPath = path.join(this.root, OWNER_LOCK);
    const bytes = await this.fs.readFile(lockPath);
    const current = decode(bytes, "owner");
    const prior = snapshot.records.at(-1)!.context;
    if (!recordMatchesContext(current, prior)) throw new LockFailure("owner lock does not match journal");
    await this.verifyOldOwnerStopped(snapshot, current);
    const next: AttemptContext = { ...structuredClone(prior), fence: snapshot.fence + 1, owner: journalOwner(input.owner) };
    // Retain the authentication identity across retries/restarts.
    next.owner.handoffIdentityHash = snapshot.owner.handoffIdentityHash;
    const intent = await this.journal.appendIntent({ attemptId: snapshot.attemptId!, fence: snapshot.fence, action: "replace-owner", phase: snapshot.phase, payload: { nextContext: next } as unknown as JsonValue });
    await this.finishOwnerReplacement(snapshot.attemptId!, snapshot.fence, intent.id, next, bytes);
    return new LockHandle(this.root, this.fs, decode(await this.fs.readFile(lockPath), "owner"));
  }

  private async finishOwnerReplacement(
    attemptId: string,
    oldFence: number,
    intentId: string,
    nextContext: AttemptContext,
    oldBytes: Buffer,
  ): Promise<void> {
    const nextRecord: LockRecord = {
      schemaVersion: 1,
      kind: "owner",
      attemptId,
      fence: nextContext.fence,
      owner: nextContext.owner,
      checksum: "",
    };
    nextRecord.checksum = checksum({
      schemaVersion: nextRecord.schemaVersion,
      kind: nextRecord.kind,
      attemptId: nextRecord.attemptId,
      fence: nextRecord.fence,
      owner: nextRecord.owner,
    });
    const identityToken = createHash("sha256")
      .update(`${attemptId}:${nextContext.fence}`)
      .digest("hex")
      .slice(0, 24);
    const archive = path.join(
      this.root,
      `update.lock.archive-${attemptId}-${oldFence}-${identityToken}`,
    );
    if (!(await this.fs.exists(archive)))
      await this.fs.writeAtomic(archive, oldBytes, { mode: 0o600 });
    const nextPath = path.join(
      this.root,
      `update.lock.next-${identityToken}`,
    );
    if (!(await this.fs.exists(nextPath)))
      await this.fs.createExclusive(
        nextPath,
        encode({
          schemaVersion: nextRecord.schemaVersion,
          kind: nextRecord.kind,
          attemptId: nextRecord.attemptId,
          fence: nextRecord.fence,
          owner: nextRecord.owner,
        }),
        { mode: 0o600 },
      );
    const currentPath = path.join(this.root, OWNER_LOCK);
    const current = decode(await this.fs.readFile(currentPath), "owner");
    if (current.fence !== nextContext.fence) {
      await this.fs.rename(nextPath, currentPath, { replace: true });
    }
    await this.journal.appendCompletion({
      attemptId,
      fence: oldFence,
      intentId,
      phase: nextContext.phase,
      nextContext,
      result: { handedOff: true },
    });
  }

  async release(): Promise<void> {
    if (this.released) return;
    try {
      await this.assertActive();
      await this.fs.unlink(path.join(this.root, RECOVERY_LOCK));
    } finally {
      this.released = true;
      await this.guard.release();
    }
  }
}

export class UpdateLock {
  static async acquire(
    root: string,
    owner: LockOwnerInput,
    options: LockOptions = {},
  ): Promise<LockHandle> {
    validateActor(owner);
    const fs = options.fs ?? new NodeDurableFileSystem();
    const provider =
      options.identityProvider ?? new PlatformBootIdentityProvider();
    const now = options.now ?? (() => new Date());
    await verifyLocalActor(owner, provider);
    await fs.ensurePrivateDirectory(root);
    const journal =
      options.journal ??
      (await AttemptJournal.open(root, { fs, now }));
    const snapshot = await journal.readSnapshot();
    if (snapshot.initialized && !terminalAttempt(snapshot))
      throw new LockFailure(
        "an existing attempt has no active owner lock; use recovery",
      );
    const fence = snapshot.initialized ? snapshot.fence + 1 : 1;
    const lockPath = path.join(root, OWNER_LOCK);
    let record: LockRecord;
    try {
      record = {
        schemaVersion: 1,
        kind: "owner",
        attemptId: owner.attemptId,
        fence,
        owner: journalOwner(owner),
        checksum: "",
      };
      record.checksum = checksum({
        schemaVersion: record.schemaVersion,
        kind: record.kind,
        attemptId: record.attemptId,
        fence: record.fence,
        owner: record.owner,
      });
      await fs.createExclusive(
        lockPath,
        encode({
          schemaVersion: record.schemaVersion,
          kind: record.kind,
          attemptId: record.attemptId,
          fence: record.fence,
          owner: record.owner,
        }),
        { mode: 0o600 },
      );
    } catch (error) {
      if (isEexist(error))
        throw new LockFailure("update lock is already held; recovery is required");
      throw error;
    }
    try {
      await journal.beginAttempt(attemptContext(owner, fence, "PREPARED"));
    } catch (error) {
      if (await fs.exists(lockPath)) {
        const current = decode(await fs.readFile(lockPath), "owner");
        if (
          current.attemptId === owner.attemptId &&
          current.owner.pid === owner.pid
        )
          await fs.unlink(lockPath);
      }
      if (error instanceof LockFailure) throw error;
      throw new LockFailure(
        error instanceof Error ? error.message : "journal initialization failed",
      );
    }
    return new LockHandle(root, fs, record);
  }

  static async acquireRecovery(
    root: string,
    owner: LockOwnerInput,
    options: LockOptions = {},
  ): Promise<RecoveryLockHandle> {
    validateActor(owner);
    const fs = options.fs ?? new NodeDurableFileSystem();
    const provider =
      options.identityProvider ?? new PlatformBootIdentityProvider();
    const now = options.now ?? (() => new Date());
    await verifyLocalActor(owner, provider);
    await fs.ensurePrivateDirectory(root);
    const journal =
      options.journal ??
      (await AttemptJournal.open(root, { fs, now }));
    let guard: RecoveryGuard;
    try { guard = await acquireRecoveryGuard(path.join(root, "update.recovery.guard")); }
    catch { throw new LockFailure("recovery OS guard is held or unavailable"); }
    try {
    const snapshot = await journal.readSnapshot();
    const filename = path.join(root, RECOVERY_LOCK);
    const record: LockRecord = {
      schemaVersion: 1,
      kind: "recovery",
      attemptId: owner.attemptId,
      fence: Math.max(snapshot.fence, 1),
      owner: journalOwner(owner),
      checksum: "",
    };
    const base = {
      schemaVersion: record.schemaVersion,
      kind: record.kind,
      attemptId: record.attemptId,
      fence: record.fence,
      owner: record.owner,
    } as const;
    record.checksum = checksum(base);

    const createRecovery = async () => {
      await fs.createExclusive(filename, encode(base), { mode: 0o600 });
    };
    try {
      await createRecovery();
    } catch (error) {
      if (!isEexist(error)) throw error;
      let existing: LockRecord;
      try {
        existing = decode(await fs.readFile(filename), "recovery");
      } catch (decodeError) {
        throw new LockFailure(
          decodeError instanceof Error
            ? `recovery lock is corrupt: ${decodeError.message}`
            : "recovery lock is corrupt",
        );
      }
      let currentBoot: BootIdentity;
      try {
        currentBoot = await provider.current();
      } catch {
        throw new LockFailure("cannot verify stale recovery lock boot identity");
      }
      if (existing.owner.bootIdentity !== currentBoot.value)
        throw new LockFailure("stale recovery owner boot identity differs");
      let alive: boolean;
      try {
        alive = await provider.isProcessAlive(
          existing.owner.pid,
          existing.owner.processCreatedAt,
        );
      } catch {
        throw new LockFailure("recovery owner identity cannot be verified");
      }
      if (alive) throw new LockFailure("recovery lock is already held");
      const quarantine = path.join(
        root,
        `update.recovery.lock.stale-${existing.owner.pid}-${Date.now()}-${createHash("sha256")
          .update(`${existing.checksum}:${owner.pid}:${Math.random()}`)
          .digest("hex")
          .slice(0, 12)}`,
      );
      try {
        await fs.rename(filename, quarantine, { replace: false });
      } catch (renameError) {
        throw new LockFailure(
          `stale recovery lock was claimed by another process: ${
            renameError instanceof Error ? renameError.message : "rename failed"
          }`,
        );
      }
      try {
        await createRecovery();
      } catch (retryError) {
        if (isEexist(retryError))
          throw new LockFailure("recovery lock claim lost a race");
        throw retryError;
      }
    }
    return new RecoveryLockHandle(
      root,
      fs,
      journal,
      provider,
      record,
      guard,
      options.servicePort,
    );
    } catch (error) { await guard.release(); throw error; }
  }
}
