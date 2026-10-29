import { ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  AttemptJournal,
  AttemptJournalSnapshot,
  JsonValue,
  JournalCorruptError,
} from "../state/attempt-journal";
import {
  PlatformBootIdentityProvider,
  ProcessIdentityProvider,
} from "../state/boot-identity";
import { LockHandle, RecoveryLockHandle, UpdateLock } from "../state/update-lock";
import { OperatorRecoveryAuthority } from './operator-authority';
import { randomUUID } from 'node:crypto';
import {
  CurrentLinkSwitcher,
} from "../platform/current-link";
import {
  DurableFileSystem,
  NodeDurableFileSystem,
} from "../platform/durable-fs";
import { loadInstallEnvironment } from "../launcher";
import {
  UpdateCapabilityAuthority,
  encodeInheritedCapability,
} from "./capability";
import { UpdateRollbackService } from "./rollback";
import { RetentionService } from "./retention";

export interface UpdateOrchestrationAttempt {
  attemptId: string;
  installRoot: string;
  handoffIdentity: string;
  servicePort?: number;
  timeoutMs?: number;
  recovery?: boolean;
}

export interface CommittedUpdate {
  state: "committed";
  attemptId: string;
  fence: number;
  version: string;
}

export interface RolledBackUpdate {
  state: "rolled_back";
  attemptId: string;
  fence: number;
  reason: string;
}

export type UpdateOrchestrationResult =
  | CommittedUpdate
  | RolledBackUpdate;

export interface UpdateOrchestratorHooks {
  inspect(attempt: UpdateOrchestrationAttempt): Promise<AttemptJournalSnapshot>;
  waitForHandoff(
    attempt: UpdateOrchestrationAttempt,
  ): Promise<AttemptJournalSnapshot>;
  forward(
    attempt: UpdateOrchestrationAttempt,
    snapshot: AttemptJournalSnapshot,
  ): Promise<UpdateOrchestrationResult>;
  rollback(
    attempt: UpdateOrchestrationAttempt,
    snapshot: AttemptJournalSnapshot,
    reason: string,
  ): Promise<RolledBackUpdate>;
  restartCommitted(
    attempt: UpdateOrchestrationAttempt,
    snapshot: AttemptJournalSnapshot,
  ): Promise<CommittedUpdate>;
}

export type RecoveryAction =
  | "restart-old"
  | "continue-handoff"
  | "rollback"
  | "restart-new";

export function recoveryActionFor(
  snapshot: AttemptJournalSnapshot,
): RecoveryAction {
  if (!snapshot.initialized || !snapshot.phase) return "restart-old";
  switch (snapshot.phase) {
    case "PREPARED":
    case "MAINTENANCE":
    case "SNAPSHOT_READY":
      return "restart-old";
    case "HANDOFF_READY":
      return "continue-handoff";
    case "COMMITTED":
      return "restart-new";
    case "OLD_STOPPED":
    case "SWITCH_INTENT":
    case "CURRENT_SWITCHED":
    case "MIGRATING":
    case "MIGRATED_VERIFIED":
    case "READY_TO_COMMIT":
    case "ROLLBACK_INTENT":
      return "rollback";
    case "ROLLED_BACK":
    case "FAILED":
    case "ABORTED":
      return "restart-old";
  }
}

export class UpdateOrchestrator {
  constructor(private readonly hooks: UpdateOrchestratorHooks) {}

  async run(
    attempt: UpdateOrchestrationAttempt,
  ): Promise<UpdateOrchestrationResult> {
    // Inherited continuation is launched before Nest closes. Only explicit
    // operator recovery may dispatch pre-handoff phases into rollback.
    const initial = attempt.recovery
      ? await this.hooks.inspect(attempt)
      : await this.hooks.waitForHandoff(attempt);
    if (recoveryActionFor(initial) === "restart-new") {
      return this.hooks.restartCommitted(attempt, initial);
    }
    if (attempt.recovery) {
      if (!initial.initialized || initial.attemptId !== attempt.attemptId) throw new Error('recovery attempt is uninitialized or changed');
      return this.hooks.rollback(attempt, initial, 'interrupted update');
    }
    const handoff = initial;
    try {
      const forwarded = await this.hooks.forward(attempt, handoff);
      if (forwarded.state === "rolled_back") return forwarded;
      const latest = await this.hooks.inspect(attempt);
      return await this.hooks.restartCommitted(attempt, latest);
    } catch (error) {
      const current = await this.hooks.inspect(attempt);
      if (recoveryActionFor(current) === "restart-new") {
        return this.hooks.restartCommitted(attempt, current);
      }
      if (recoveryActionFor(current) === "rollback") {
        return this.hooks.rollback(
          attempt,
          current,
          error instanceof Error ? error.message : "update failed",
        );
      }
      throw error;
    }
  }
}

interface PreparedUpdateJournal {
  stagingPath: string;
  targetVersion: string;
  artifactSha256: string;
  manifestSha256: string;
  databasePath: string;
}

interface RunningServer {
  child: ChildProcess;
  baseUrl: string;
  stage: "validate" | "gated";
  stopped: boolean;
  processCreatedAt: string;
}

function isObject(
  value: JsonValue | undefined,
): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function latestPayload(
  snapshot: AttemptJournalSnapshot,
  action: string,
): Record<string, JsonValue> {
  const intent = [...snapshot.records]
    .reverse()
    .find((record) => record.kind === "intent" && record.action === action);
  if (!intent || !isObject(intent.payload)) {
    throw new Error(`journal action ${action} has no verified payload`);
  }
  return intent.payload;
}

function preparedUpdate(snapshot: AttemptJournalSnapshot): PreparedUpdateJournal {
  const value = latestPayload(snapshot, "prepare-update");
  for (const key of [
    "stagingPath",
    "targetVersion",
    "artifactSha256",
    "manifestSha256",
    "databasePath",
  ] as const) {
    if (typeof value[key] !== "string") {
      throw new Error("prepared update journal payload is incomplete");
    }
  }
  if (
    !/^[a-f0-9]{64}$/.test(value.artifactSha256 as string) ||
    !/^[a-f0-9]{64}$/.test(value.manifestSha256 as string)
  ) {
    throw new Error("prepared update hashes are invalid");
  }
  return value as unknown as PreparedUpdateJournal;
}

function within(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function heartbeatFresh(snapshot: AttemptJournalSnapshot): boolean {
  if (!snapshot.owner) return false;
  const at = Date.parse(snapshot.owner.heartbeatAt);
  return Number.isFinite(at) && Date.now() - at <= 10 * 60 * 1000;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port =
    address && typeof address === "object" ? address.port : undefined;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("could not allocate an internal update port");
  return port;
}

export async function stopServer(server: RunningServer | undefined, identity: ProcessIdentityProvider = new PlatformBootIdentityProvider(), timeoutMs = 15_000): Promise<void> {
  if (!server || server.stopped) return;
  const pid = server.child.pid;
  if (!pid || !server.processCreatedAt) throw new Error("server exit identity unavailable");
  const gone = () => identity.isProcessAlive(pid, server.processCreatedAt).then(alive => !alive);
  if (await gone()) { server.stopped = true; return; }
  const signalAndWait = async (signal: NodeJS.Signals) => {
    let timer: ReturnType<typeof setTimeout>;
    const exited = new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); server.child.removeListener("exit", done); resolve(); };
      server.child.once("exit", done);
      timer = setTimeout(done, timeoutMs);
    });
    server.child.kill(signal);
    await exited;
  };
  await signalAndWait("SIGTERM");
  if (!(await gone())) {
    await signalAndWait("SIGKILL");
    if (!(await gone())) throw new Error("server exit not proven after SIGKILL");
  }
  server.stopped = true;
}

async function waitForJson(
  url: string,
  init: RequestInit,
  deadline: number,
  accept: (status: number, value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(1000),
      });
      const text = await response.text();
      const value = JSON.parse(text) as Record<string, unknown>;
      if (accept(response.status, value)) return value;
      lastError = new Error(`health status ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("health failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error("update health timed out");
}

export class ManagedUpdateHooks implements UpdateOrchestratorHooks {
  private readonly identity: ProcessIdentityProvider;
  private readonly fs: DurableFileSystem;
  private ownership?: {journal:AttemptJournal; lock:LockHandle; recovery:RecoveryLockHandle};
  private readonly runtime: NodeJS.ProcessEnv;
  private readonly operatorAuthority?: OperatorRecoveryAuthority;

  constructor(
    private readonly handoffIdentity: string,
    options: {
      identity?: ProcessIdentityProvider;
      fs?: DurableFileSystem;
      runtime?: NodeJS.ProcessEnv;
      operatorAuthority?: OperatorRecoveryAuthority;
    } = {},
  ) {
    this.identity = options.identity ?? new PlatformBootIdentityProvider();
    this.fs = options.fs ?? new NodeDurableFileSystem();
    this.runtime = options.runtime ?? {};
    this.operatorAuthority = options.operatorAuthority;
  }

  private async own(attempt:UpdateOrchestrationAttempt):Promise<AttemptJournal> {
    if(this.ownership) {await this.ownership.recovery.assertActive(); await this.ownership.lock.assertActive(); return this.ownership.journal;}
    const snapshot=await AttemptJournal.inspectRecoverable(attempt.installRoot);
    if(snapshot.attemptId!==attempt.attemptId || !snapshot.owner) throw new Error('recovery attempt changed');
    const boot=await this.identity.current();
    const actor={attemptId:attempt.attemptId,bootIdentity:boot.value,pid:process.pid,processCreatedAt:await this.identity.processCreatedAt(process.pid),heartbeatAt:new Date().toISOString(),currentVersion:snapshot.currentVersion!,targetVersion:snapshot.targetVersion!,previousVersion:snapshot.previousVersion,backupId:snapshot.backupId};
    const recovery=await UpdateLock.acquireRecovery(attempt.installRoot,actor,{identityProvider:this.identity,fs:this.fs,servicePort:attempt.servicePort,operatorAuthority:this.operatorAuthority});
    const journal=recovery.journal;
    try {
      // Retain kernel exclusion and exact operator authority across repair and
      // strict reread. repairJournalTail proves old/replacement writer exit.
      await recovery.repairJournalTail();
      const strict=await AttemptJournal.inspect(attempt.installRoot,{fs:this.fs});
      if(strict.attemptId!==snapshot.attemptId || strict.fence!==snapshot.fence || strict.sequence!==snapshot.sequence)
        throw new Error('recovery prefix changed before ownership');
      const lock=await recovery.recoverAttempt({owner:actor,expectedFence:snapshot.fence,handoffIdentity:this.handoffIdentity});
      this.ownership={journal,lock,recovery};
      return journal;
    } catch(error) {await recovery.release(); throw error;}
  }

  private async releaseOwnership():Promise<void> {
    if(!this.ownership) return;
    await this.ownership.lock.release();
    await this.ownership.recovery.release();
    this.ownership=undefined;
  }

  private async stopRecordedChildren(attempt:UpdateOrchestrationAttempt):Promise<void> {
    const file=path.join(attempt.installRoot,'update.processes.json');
    const hasLedger=await this.fs.exists(file);
    let children: Array<{pid:number;createdAt:string;boot:string}>;
    if(hasLedger) {
      const ledger=JSON.parse((await this.fs.readFile(file)).toString('utf8'));
      if(ledger.attemptId!==attempt.attemptId || !Array.isArray(ledger.children)) throw new Error('child identity ledger mismatched');
      children=ledger.children;
    } else {
      // Ledger retirement does not retire the durable, verified startup proof.
      // Recover that exact child even if the updater died during lock release.
      if(!this.ownership) throw new Error('terminal child recovery requires retained ownership');
      await this.ownership.recovery.assertActive();
      const snapshot=await this.ownership.journal.readSnapshot();
      if(snapshot.attemptId!==attempt.attemptId) throw new Error('terminal child attempt changed');
      if(!['COMMITTED','ROLLED_BACK','ABORTED'].includes(snapshot.phase ?? '')) return;
      const action=snapshot.phase==='COMMITTED'?'verify-committed-restart':'launch-terminal';
      const intents=new Map(snapshot.records.filter(record=>record.kind==='intent' && record.action===action).map(record=>[record.id,record]));
      const completed=[...snapshot.records].reverse().find(record=>record.kind==='completion' && record.intentId && intents.has(record.intentId));
      if(!completed) return;
      const proof=completed.result;
      const intent=intents.get(completed.intentId!)!;
      const version=snapshot.phase==='COMMITTED'?snapshot.targetVersion:snapshot.previousVersion ?? snapshot.currentVersion;
      const release=await this.fs.realpath(path.join(attempt.installRoot,'current'));
      if(!isObject(proof) || !isObject(intent.payload) || completed.context.attemptId!==attempt.attemptId || completed.phase!==snapshot.phase ||
        !Number.isSafeInteger(proof.pid) || Number(proof.pid)<1 || typeof proof.createdAt!=='string' || !proof.createdAt || typeof proof.boot!=='string' || !proof.boot ||
        typeof proof.nonce!=='string' || proof.nonce.length<16 || proof.health!=='ok' || proof.version!==version || intent.payload.version!==version ||
        typeof proof.release!=='string' || !within(path.join(attempt.installRoot,'releases'),proof.release) || path.relative(proof.release,release)!=='' ||
        // Historical Node 20 junction spelling survives in the original intent,
        // while the verified completion uses the canonical release spelling.
        typeof intent.payload.release!=='string' || !path.isAbsolute(intent.payload.release) || path.resolve(intent.payload.release)!==proof.release)
        throw new Error('durable terminal child identity/version proof mismatched');
      children=[{pid:proof.pid as number,createdAt:proof.createdAt,boot:proof.boot}];
    }
    const boot=await this.identity.current();
    for(const record of children) {
      if(record.boot!==boot.value) continue; // A different OS boot cannot retain that process.
      if(typeof record.pid!=='number' || typeof record.createdAt!=='string') throw new Error('child identity missing');
      if(await this.identity.isProcessAlive(record.pid,record.createdAt)) {
        const deadline=Date.now()+(attempt.timeoutMs ?? 15_000);
        // Never signal a reused PID. Every signal is preceded by identity proof.
        process.kill(record.pid,'SIGTERM');
        while(Date.now()<deadline && await this.identity.isProcessAlive(record.pid,record.createdAt)) await new Promise(r=>setTimeout(r,50));
        if(await this.identity.isProcessAlive(record.pid,record.createdAt)) {
          process.kill(record.pid,'SIGKILL');
          const forced=Date.now()+(attempt.timeoutMs ?? 15_000);
          while(Date.now()<forced && await this.identity.isProcessAlive(record.pid,record.createdAt)) await new Promise(r=>setTimeout(r,50));
          if(await this.identity.isProcessAlive(record.pid,record.createdAt)) throw new Error('recorded child exit not proven');
        }
      }
    }
    if(hasLedger) await this.fs.unlink(file);
  }

  private async recordChild(attempt:UpdateOrchestrationAttempt, child:ChildProcess):Promise<string> {
    const createdAt=await this.identity.processCreatedAt(child.pid!);
    const boot=(await this.identity.current()).value;
    const file=path.join(attempt.installRoot,'update.processes.json');
    let children:unknown[]=[];
    if(await this.fs.exists(file)) {
      const previous=JSON.parse((await this.fs.readFile(file)).toString('utf8'));
      if(previous.attemptId!==attempt.attemptId) throw new Error('foreign child ledger');
      children=previous.children;
    }
    await this.fs.writeAtomic(file,Buffer.from(JSON.stringify({attemptId:attempt.attemptId,children:[...children,{pid:child.pid,createdAt,boot}]})+'\n'),{mode:0o600});
    return createdAt;
  }

  async inspect(_attempt: UpdateOrchestrationAttempt) {
    if(_attempt.recovery) return (await this.own(_attempt)).readSnapshot();
    return AttemptJournal.inspect(_attempt.installRoot);
  }

  async waitForHandoff(
    attempt: UpdateOrchestrationAttempt,
  ): Promise<AttemptJournalSnapshot> {
    const deadline = Date.now() + (attempt.timeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      let snapshot: AttemptJournalSnapshot;
      try { snapshot = await AttemptJournal.inspect(attempt.installRoot); }
      catch(error) {
        // A read-only waiter may catch the old writer between append and flush.
        // Retry only an incomplete tail, bounded by the handoff deadline; never repair it.
        if(error instanceof JournalCorruptError && /partial journal tail/.test(error.message)) {
          await new Promise(resolve=>setTimeout(resolve,100));
          continue;
        }
        throw error;
      }
      if (
        snapshot.attemptId === attempt.attemptId &&
        snapshot.phase === "HANDOFF_READY" &&
        snapshot.pending === null &&
        heartbeatFresh(snapshot)
      ) {
        const owner = snapshot.owner!;
        const boot = await this.identity.current();
        if (boot.value !== owner.bootIdentity) {
          throw new Error("old update owner boot identity changed");
        }
        if (
          await this.identity.isProcessAlive(
            owner.pid,
            owner.processCreatedAt,
          )
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        if (attempt.servicePort && this.identity.listeningPid) {
          const portOwner = await this.identity
            .listeningPid(attempt.servicePort)
            .catch(() => undefined);
          if (portOwner === owner.pid) {
            throw new Error("old update owner still owns the service port");
          }
        }
        return snapshot;
      }
      if (
        snapshot.attemptId !== undefined &&
        snapshot.attemptId !== attempt.attemptId
      ) {
        throw new Error("journal attempt changed during handoff");
      }
      if (snapshot.phase === "COMMITTED") return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("timed out waiting for verified HANDOFF_READY");
  }

  async forward(
    attempt: UpdateOrchestrationAttempt,
    snapshot: AttemptJournalSnapshot,
  ): Promise<UpdateOrchestrationResult> {
    const boot = await this.identity.current();
    const createdAt = await this.identity.processCreatedAt(process.pid);
    const actor = {
      attemptId: attempt.attemptId,
      bootIdentity: boot.value,
      pid: process.pid,
      processCreatedAt: createdAt,
      heartbeatAt: new Date().toISOString(),
      currentVersion: snapshot.currentVersion!,
      targetVersion: snapshot.targetVersion!,
      previousVersion: snapshot.previousVersion,
      backupId: snapshot.backupId,
    };
    const recovery = await UpdateLock.acquireRecovery(
      attempt.installRoot,
      actor,
      {
        identityProvider: this.identity,
        fs: this.fs,
        servicePort: attempt.servicePort,
      },
    );
    let lock: LockHandle | undefined;
    let running: RunningServer | undefined;
    let currentFence = snapshot.fence;
    const journal = recovery.journal;
    try {
      lock = await recovery.takeoverHandoff({
        owner: actor,
        handoffIdentity: this.handoffIdentity,
      });
      currentFence = lock.fence;
      this.ownership={journal,lock,recovery};
      await this.appendAction(
        journal,
        attempt.attemptId,
        currentFence,
        "record-old-stopped",
        "OLD_STOPPED",
      );
      await lock.heartbeat();

      const prepared = preparedUpdate(snapshot);
      if (!within(attempt.installRoot, prepared.stagingPath)) {
        throw new Error("prepared update staging path escaped the install root");
      }
      const releasePath = path.join(
        attempt.installRoot,
        "releases",
        `v${prepared.targetVersion}-${prepared.artifactSha256.slice(0, 12)}`,
      );
      if (!within(path.join(attempt.installRoot, "releases"), releasePath)) {
        throw new Error("update release path is unsafe");
      }
      const releaseIntent = await journal.appendIntent({
        attemptId: attempt.attemptId,
        fence: currentFence,
        action: "install-release",
        phase: "OLD_STOPPED",
        payload: { stagingPath: prepared.stagingPath, releasePath },
      });
      await this.fs.ensurePrivateDirectory(
        path.join(attempt.installRoot, "releases"),
      );
      if (await this.fs.exists(prepared.stagingPath)) {
        if (await this.fs.exists(releasePath)) {
          throw new Error("staged and installed release both exist");
        }
        await this.fs.rename(prepared.stagingPath, releasePath, {
          replace: false,
        });
      } else if (!(await this.fs.exists(releasePath))) {
        throw new Error("prepared update payload disappeared");
      }
      await journal.appendCompletion({
        attemptId: attempt.attemptId,
        fence: currentFence,
        intentId: releaseIntent.id,
        phase: "OLD_STOPPED",
        result: { releasePath },
      });

      await new CurrentLinkSwitcher(
        attempt.installRoot,
        journal,
        { fs: this.fs },
      ).switchTo(releasePath, {
        attemptId: attempt.attemptId,
        fence: currentFence,
      });
      const validationIntent = await journal.appendIntent({
        attemptId: attempt.attemptId,
        fence: currentFence,
        action: "validate-release",
        phase: "MIGRATING",
        payload: { releasePath, targetVersion: prepared.targetVersion },
      });
      const authority = new UpdateCapabilityAuthority();
      const validationPort = await freePort();
      running = await this.startServer(
          attempt,
          prepared,
          "validate",
          validationPort,
        authority,
      );
        const healthToken = authority.issue({
          attemptId: attempt.attemptId,
          fence: currentFence,
          purpose: "health",
          method: "GET",
          stage: "validate",
          expiresAt: Date.now() + 10 * 60_000,
        });
        await waitForJson(
          `${running.baseUrl}/api/v1/internal/update/health`,
          { headers: { "X-FileStation-Update-Capability": healthToken } },
          Date.now() + (attempt.timeoutMs ?? 120_000),
          (status) => status === 200,
        );
        await stopServer(running, this.identity);
        running = undefined;
        await journal.appendCompletion({
          attemptId: attempt.attemptId,
          fence: currentFence,
          intentId: validationIntent.id,
          phase: "MIGRATED_VERIFIED",
          result: { targetVersion: prepared.targetVersion, schema: "verified" },
        });

        const servicePort = attempt.servicePort ?? 8080;
        running = await this.startServer(
          attempt,
          prepared,
          "gated",
          servicePort,
          authority,
        );
        const healthToken2 = authority.issue({
          attemptId: attempt.attemptId,
          fence: currentFence,
          purpose: "health",
          method: "GET",
          stage: "gated",
          expiresAt: Date.now() + 10 * 60_000,
        });
        await waitForJson(
          `${running.baseUrl}/api/v1/internal/update/health`,
          { headers: { "X-FileStation-Update-Capability": healthToken2 } },
          Date.now() + (attempt.timeoutMs ?? 120_000),
          (status, value) =>
            status === 200 && value.status === "gated",
        );
        const promoteToken = authority.issue({
          attemptId: attempt.attemptId,
          fence: currentFence,
          purpose: "promote",
          method: "POST",
          stage: "gated",
          expiresAt: Date.now() + 10 * 60_000,
        });
        const promoted = await waitForJson(
          `${running.baseUrl}/api/v1/internal/update/promote-ready`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-FileStation-Update-Capability": promoteToken,
            },
            body: JSON.stringify({ schema_version: 1 }),
          },
          Date.now() + (attempt.timeoutMs ?? 120_000),
          (status, value) =>
            status === 201 && value.schema_version === 1,
        );
        if (
          !isObject(promoted.readiness as JsonValue) ||
          typeof promoted.receipt !== "string" ||
          !authority.verifyReceipt(
            promoted.receipt,
            promoted.readiness as never,
          )
        ) {
          throw new Error("promote readiness receipt is invalid");
        }
        const readiness = promoted.readiness as Record<string, JsonValue>;
        if (
          readiness.attempt_id !== attempt.attemptId ||
          readiness.fence !== currentFence ||
          readiness.target_version !== prepared.targetVersion ||
          readiness.health !== "ok" ||
          typeof readiness.migration_id !== "string" ||
          typeof readiness.schema_sha256 !== "string"
        ) {
          throw new Error("promote readiness changed schema or target");
        }

        await this.appendAction(journal, attempt.attemptId, currentFence, "ready-to-commit", "READY_TO_COMMIT", {
          targetVersion: prepared.targetVersion,
          receipt: promoted.receipt,
        });
        await this.appendAction(journal, attempt.attemptId, currentFence, "commit-update", "COMMITTED", {
          targetVersion: prepared.targetVersion,
          migrationId: readiness.migration_id as string,
          schemaSha256: readiness.schema_sha256 as string,
        });
        await journal.writeStatusProjection();
        await waitForJson(
          `${running.baseUrl}/api/v1/internal/update/health`,
          { headers: { "X-FileStation-Update-Capability": healthToken2 } },
          Date.now() + (attempt.timeoutMs ?? 120_000),
          (status, value) =>
            status === 200 && value.status === "committed",
        );
        await stopServer(running, this.identity);
        running = undefined;
        // Keep both authorities through independent restart and retention.
      return {
        state: "committed",
        attemptId: attempt.attemptId,
        fence: currentFence,
        version: prepared.targetVersion,
      };
    } catch (error) {
      await stopServer(running, this.identity);
      const current = await AttemptJournal.inspect(attempt.installRoot);
      if (current.phase === "COMMITTED") {
        throw error;
      }
      try {
        const rolledBack = await this.rollback(
          attempt,
          current,
          error instanceof Error ? error.message : "update failed",
        );
        return rolledBack;
      } catch {
        // Keep both owner records when rollback cannot be proven complete.
        throw error;
      }
    }
  }

  async rollback(
    attempt: UpdateOrchestrationAttempt,
    snapshot: AttemptJournalSnapshot,
    reason: string,
  ): Promise<RolledBackUpdate> {
    const journal = await this.own(attempt);
    await this.stopRecordedChildren(attempt);
    let current=await journal.readSnapshot();
    if(current.phase==='COMMITTED') throw new Error('COMMITTED cannot roll back');
    const early=['PREPARED','MAINTENANCE','SNAPSHOT_READY','HANDOFF_READY','ABORTED'].includes(current.phase!) || current.records.some(r=>(r.kind==='completion' && isObject(r.result) && r.result.rollbackRequired===false) || (r.kind==='intent' && r.action==='rollback-plan' && isObject(r.payload) && r.payload.restoreRequired===false));
    const linkActions=['stage-current-link','detach-current','attach-current','replace-current','cleanup-staged-link','restore-previous'];
    // Resolve the forward operation first. Completion records preserve the
    // original intent and explicitly state interruption, never claim success.
    if(current.pending && linkActions.includes(current.pending.action)) {
      await new CurrentLinkSwitcher(attempt.installRoot,journal,{fs:this.fs}).recover(current);
    } else if(current.pending && !['rollback-database','select-previous','complete-rollback','launch-terminal'].includes(current.pending.action)) {
      if(!['prepare-update','enter-maintenance','snapshot-database','bind-handoff-identity','close-application','record-old-stopped','install-release','validate-release','ready-to-commit','commit-update','rollback-plan'].includes(current.pending.action)) throw new Error('unknown pending recovery action');
      await journal.appendCompletion({attemptId:attempt.attemptId,fence:current.fence,intentId:current.pending.intentId,phase:early?'ROLLBACK_INTENT':'ROLLBACK_INTENT',result:{interrupted:true,rollbackRequired:!early}});
    }
    current=await journal.readSnapshot();
    if(!current.records.some(r=>r.kind==='intent' && r.action==='rollback-plan') && !['ROLLED_BACK','ABORTED'].includes(current.phase!)) {
      const plan=await journal.appendIntent({attemptId:attempt.attemptId,fence:current.fence,action:'rollback-plan',phase:'ROLLBACK_INTENT',payload:{restoreRequired:!early}});
      await journal.appendCompletion({attemptId:attempt.attemptId,fence:current.fence,intentId:plan.id,phase:'ROLLBACK_INTENT',result:{rollbackRequired:!early}});
      current=await journal.readSnapshot();
    }
    const terminal=current.records.some(r=>r.kind==='completion' && isObject(r.result) && typeof r.result.reason==='string' && ['ROLLED_BACK','ABORTED'].includes(r.phase!));
    const alreadyRestored=current.records.some(r=>r.kind==='completion' && isObject(r.result) && r.result.restored===true && typeof r.result.snapshotPath==='string');
    if(!early && !terminal && !alreadyRestored) {
      const prepared=preparedUpdate(current);
      const backup=latestPayload(current,'snapshot-database');
      if(typeof backup.path!=='string') throw new Error('rollback snapshot path unavailable');
      await new UpdateRollbackService({fs:this.fs}).restoreDatabase({root:attempt.installRoot,journal,attemptId:attempt.attemptId,fence:current.fence,databasePath:prepared.databasePath,snapshotPath:backup.path});
    }
    current=await journal.readSnapshot();
    // The earliest switch describes the pre-update release. A recover() result
    // is never used as an instruction to select that release.
    const firstSwitch=current.records.find(r=>r.kind==='intent' && linkActions.includes(r.action ?? '') && isObject(r.payload) && typeof r.payload.originalTarget==='string');
    // Windows Node 20 readlink(junction) can retain a trailing separator in
    // historical switch intents. Use the same absolute release spelling as
    // the independent launcher's __dirname proof, including during recovery.
    const recordedTarget=firstSwitch && isObject(firstSwitch.payload) ? firstSwitch.payload.originalTarget as string : await this.fs.realpath(path.join(attempt.installRoot,'current'));
    if(!path.isAbsolute(recordedTarget)) throw new Error('previous release target must be absolute');
    const oldTarget=path.resolve(recordedTarget);
    if(!within(path.join(attempt.installRoot,'releases'),oldTarget)) throw new Error('previous release escaped install');
    if(!(await this.fs.exists(path.join(attempt.installRoot,'current'))) || await this.fs.realpath(path.join(attempt.installRoot,'current'))!==oldTarget) {
      // Use a distinct operation identity so Windows staging paths from the
      // forward switch cannot collide with this deliberate reverse switch.
      const select=current.pending?.action==='select-previous' ? current.pending : await journal.appendIntent({attemptId:attempt.attemptId,fence:current.fence,action:'select-previous',phase:'ROLLBACK_INTENT',payload:{target:oldTarget,stage:path.join(attempt.installRoot,`.rollback-current-${current.fence}`),detached:path.join(attempt.installRoot,`.rollback-new-${current.fence}`)}});
      if(!isObject(select.payload) || typeof select.payload.stage!=='string' || typeof select.payload.detached!=='string') throw new Error('previous-selection intent malformed');
      const stage=select.payload.stage;
      if(!(await this.fs.exists(stage))) {
        if(process.platform==='win32') await this.fs.createJunction(oldTarget,stage); else await this.fs.symlink(oldTarget,stage);
      } else if(await this.fs.realpath(stage)!==oldTarget) throw new Error('rollback staging target differs');
      if(process.platform==='win32') {
        const detached=select.payload.detached;
        if(await this.fs.exists(path.join(attempt.installRoot,'current'))) await this.fs.rename(path.join(attempt.installRoot,'current'),detached,{replace:false});
      }
      await this.fs.rename(stage,path.join(attempt.installRoot,'current'),{replace:process.platform!=='win32'});
      await journal.appendCompletion({attemptId:attempt.attemptId,fence:current.fence,intentId:('intentId' in select ? select.intentId : select.id)!,phase:'ROLLBACK_INTENT',result:{target:oldTarget}});
    } else if(current.pending?.action==='select-previous') {
      await journal.appendCompletion({attemptId:attempt.attemptId,fence:current.fence,intentId:current.pending.intentId,phase:'ROLLBACK_INTENT',result:{target:oldTarget}});
    }
    const rolledBackState = await journal.readSnapshot();
    if (rolledBackState.pending?.action==='complete-rollback' || !['ROLLED_BACK','ABORTED'].includes(rolledBackState.phase!)) {
      const intent = rolledBackState.pending?.action==='complete-rollback' ? {id:rolledBackState.pending.intentId} : await journal.appendIntent({
        attemptId: attempt.attemptId,
        fence: rolledBackState.fence,
        action: "complete-rollback",
        phase: "ROLLED_BACK",
        payload: { reason: "pre-commit-failure", target:oldTarget },
      });
      await journal.appendCompletion({
        attemptId: attempt.attemptId,
        fence: rolledBackState.fence,
        intentId: intent.id,
        phase: "ROLLED_BACK",
        result: { reason },
      });
    }
    await journal.writeStatusProjection();
    await this.launchTerminal(attempt,journal,oldTarget,rolledBackState.previousVersion ?? rolledBackState.currentVersion!,false);
    await this.releaseOwnership();
    return {
      state: "rolled_back",
      attemptId: attempt.attemptId,
      fence: rolledBackState.fence,
      reason,
    };
  }

  async restartCommitted(
    attempt: UpdateOrchestrationAttempt,
    snapshot: AttemptJournalSnapshot,
  ): Promise<CommittedUpdate> {
    const journal=await this.own(attempt);
    await this.stopRecordedChildren(attempt);
    snapshot=await journal.readSnapshot();
    if(snapshot.pending?.action==='commit-update') {
      await journal.appendCompletion({attemptId:attempt.attemptId,fence:snapshot.fence,intentId:snapshot.pending.intentId,phase:'COMMITTED',result:{recoveredCommit:true}});
      snapshot=await journal.readSnapshot();
    }
    const prepared = preparedUpdate(snapshot);
    const current = await this.fs.realpath(
      path.join(attempt.installRoot, "current"),
    );
    const packageJson = JSON.parse(
      (await readFile(path.join(current, "package.json"), "utf8")),
    ) as { version?: unknown };
    if (packageJson.version !== prepared.targetVersion) {
      throw new Error("COMMITTED current release version is invalid");
    }
    await this.launchTerminal(attempt,journal,current,prepared.targetVersion,true);
    await new RetentionService(attempt.installRoot, {
      fs: this.fs,
    })
      .cleanup(await journal.readSnapshot())
      .catch(() => undefined);
    await this.releaseOwnership();
    return {
      state: "committed",
      attemptId: attempt.attemptId,
      fence: snapshot.fence,
      version: prepared.targetVersion,
    };
  }

  private async launchTerminal(attempt:UpdateOrchestrationAttempt,journal:AttemptJournal,release:string,version:string,committed:boolean):Promise<void> {
    let snapshot=await journal.readSnapshot();
    const action=committed?'verify-committed-restart':'launch-terminal';
    if(snapshot.pending && snapshot.pending.action!==action) throw new Error('terminal launch pending action differs');
    // Resume an existing Node 20 junction spelling without accepting a
    // relative path or a different absolute release from the durable intent.
    if(snapshot.pending && (!isObject(snapshot.pending.payload) || snapshot.pending.payload.version!==version || typeof snapshot.pending.payload.release!=='string' || !path.isAbsolute(snapshot.pending.payload.release) || path.resolve(snapshot.pending.payload.release)!==release)) throw new Error('terminal launch intent identity differs');
    // A previous child may have died after startup but before its completion.
    // Reuse the durable intent; require a fresh independent process every retry.
    const intent=snapshot.pending ? {id:snapshot.pending.intentId} : await journal.appendIntent({attemptId:attempt.attemptId,fence:snapshot.fence,action,phase:snapshot.phase!,payload:{version,release}});
    snapshot=await journal.readSnapshot();
    const port=attempt.servicePort ?? 8080;
    if(!this.identity.listeningPid) throw new Error('terminal launcher cannot prove service port ownership');
    if(await this.identity.listeningPid(port)!==undefined) throw new Error('terminal restart port is occupied; independent restart required');
    const authority=new UpdateCapabilityAuthority();
    const claims={attemptId:attempt.attemptId,fence:snapshot.fence,version,release,phase:snapshot.phase!,parentPid:process.pid,parentCreatedAt:await this.identity.processCreatedAt(process.pid),parentBoot:(await this.identity.current()).value,expiresAt:Date.now()+(attempt.timeoutMs ?? 120_000),nonce:randomUUID()};
    const child=spawn(process.execPath,[path.join(attempt.installRoot,'updater/dist/cli.js'),'launch','--root',attempt.installRoot,'--inherited-launch'],{cwd:attempt.installRoot,env:this.osEnvironment(),windowsHide:true,detached:true,stdio:['pipe','ignore','ignore','ipc']});
    const createdAt=await this.recordChild(attempt,child);
    const response=new Promise<Record<string,unknown>>((resolve,reject)=>{
      const timer=setTimeout(()=>{cleanup();reject(new Error('independent launcher proof timed out'));},attempt.timeoutMs ?? 120_000);
      const onExit=()=>{cleanup();reject(new Error('independent launcher exited before proof'));};
      const onMessage=(value:unknown)=>{cleanup();resolve(value as Record<string,unknown>);};
      const cleanup=()=>{clearTimeout(timer);child.removeListener('exit',onExit);child.removeListener('message',onMessage);};
      child.once('message',onMessage);child.once('exit',onExit);child.once('error',onExit);
    });
    const envelope=JSON.parse(encodeInheritedCapability(authority).toString('utf8'));
    const encoded=Buffer.from(JSON.stringify({...envelope,runtime:await this.runtimeEnvironment(attempt),launch:{...claims,receipt:authority.receipt(claims)}}));
    if(encoded.length>4096) throw new Error('terminal launch envelope unbounded');
    child.stdin!.end(encoded,()=>encoded.fill(0));
    const message=await response;
    const proof=message.proof as Record<string,JsonValue>;
    if(!proof || typeof message.receipt!=='string' || !authority.verifyReceipt(message.receipt,proof as never) || proof.pid!==child.pid || proof.createdAt!==createdAt || proof.boot!==claims.parentBoot || proof.version!==version || proof.release!==release || proof.health!=='ok' || proof.attemptId!==attempt.attemptId || proof.fence!==snapshot.fence || proof.nonce!==claims.nonce || !(await this.identity.isProcessAlive(child.pid!,createdAt)) || await this.identity.listeningPid(port)!==child.pid) throw new Error('independent launcher identity/version/health proof invalid');
    await journal.appendCompletion({attemptId:attempt.attemptId,fence:snapshot.fence,intentId:intent.id,phase:snapshot.phase!,result:{version,health:'ok',pid:child.pid!,createdAt,boot:claims.parentBoot,nonce:claims.nonce,release}});
    // The child waits for this message before reconciling RESTART_VERIFIED.
    child.send({event:'verification-durable'});
    child.disconnect(); child.unref();
    await this.fs.unlink(path.join(attempt.installRoot,'update.processes.json'));
  }

  private osEnvironment():NodeJS.ProcessEnv {
    const env:NodeJS.ProcessEnv={};
    for(const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP']) if(process.env[key]!==undefined) env[key]=process.env[key];
    return env;
  }

  private async runtimeEnvironment(attempt:UpdateOrchestrationAttempt):Promise<NodeJS.ProcessEnv> {
    const loaded=await this.serverEnvironment(attempt);
    const runtime:NodeJS.ProcessEnv={};
    for(const key of ['NODE_ENV','JWT_SECRET','FILESTATION_PORT','FILESTATION_HOST','FILESTATION_DB_PATH','FILESTATION_STORAGE_PATH','FILESTATION_TEMP_PATH','FILESTATION_SERVE_STATIC','FILESTATION_WEB_URL','FILESTATION_WEB_DIST','FILESTATION_CORS_ORIGINS','FILESTATION_CONTAINER','FILESTATION_DEPLOYMENT_MODE']) if(loaded[key]!==undefined) runtime[key]=loaded[key];
    return runtime;
  }

  private async appendAction(
    journal: AttemptJournal,
    attemptId: string,
    fence: number,
    action: string,
    phase: "OLD_STOPPED" | "READY_TO_COMMIT" | "COMMITTED",
    payload?: JsonValue,
  ): Promise<void> {
    const intent = await journal.appendIntent({
      attemptId,
      fence,
      action,
      phase,
      ...(payload === undefined ? {} : { payload }),
    });
    await journal.appendCompletion({
      attemptId,
      fence,
      intentId: intent.id,
      phase,
    });
  }

  private async startServer(
    attempt: UpdateOrchestrationAttempt,
    prepared: PreparedUpdateJournal,
    stage: "validate" | "gated",
    port: number,
    authority: UpdateCapabilityAuthority,
  ): Promise<RunningServer> {
    const release = await this.fs.realpath(
      path.join(attempt.installRoot, "current"),
    );
    const main = path.join(release, "apps/server/dist/main.js");
    const snapshot = await AttemptJournal.inspect(attempt.installRoot);
    const args = [
      main,
      `--startup-mode=${stage}`,
      `--attempt-id=${attempt.attemptId}`,
      `--fence=${snapshot.fence}`,
      `--install-root=${attempt.installRoot}`,
      `--backup-id=${snapshot.backupId}`,
      `--target-version=${prepared.targetVersion}`,
    ];
    const child = spawn(process.execPath, args, {
      cwd: attempt.installRoot,
      env: this.osEnvironment(),
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
    });
    if (!child.stdin) {
      child.kill();
      throw new Error("server startup did not receive an inherited capability pipe");
    }
    const createdAt=await this.recordChild(attempt,child);
    const inherited = Buffer.from(JSON.stringify({...JSON.parse(encodeInheritedCapability(authority).toString('utf8')),runtime:{...await this.runtimeEnvironment(attempt),FILESTATION_HOST:'127.0.0.1',FILESTATION_PORT:String(port)}}));
    try {
      child.stdin.end(inherited,()=>inherited.fill(0));
    } catch(error) {inherited.fill(0);throw error;}
    return {
      child,
      baseUrl: `http://127.0.0.1:${port}`,
      stage,
      stopped: false,
      processCreatedAt: createdAt,
    };
  }

  private async serverEnvironment(
    attempt: UpdateOrchestrationAttempt,
  ): Promise<NodeJS.ProcessEnv> {
    const loaded = await loadInstallEnvironment(attempt.installRoot,{processEnvironment:{...process.env,...this.runtime}});
    return {
      ...process.env,
      ...loaded.values,
      FILESTATION_INSTALL_ROOT: attempt.installRoot,
      FILESTATION_MANAGED_LAUNCH: "true",
    };
  }

}

export function createManagedUpdateOrchestrator(options: {
  handoffIdentity: string;
  identity?: ProcessIdentityProvider;
  fs?: DurableFileSystem;
  runtime?: NodeJS.ProcessEnv;
  operatorAuthority?: OperatorRecoveryAuthority;
}): UpdateOrchestrator {
  return new UpdateOrchestrator(new ManagedUpdateHooks(
    options.handoffIdentity,
    options,
  ));
}
