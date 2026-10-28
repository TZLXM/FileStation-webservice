import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  AttemptJournal,
  AttemptJournalSnapshot,
  JsonValue,
} from "../state/attempt-journal";
import {
  PlatformBootIdentityProvider,
  ProcessIdentityProvider,
} from "../state/boot-identity";
import { LockHandle, UpdateLock } from "../state/update-lock";
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
    const initial = await this.hooks.inspect(attempt);
    if (recoveryActionFor(initial) === "restart-new") {
      return this.hooks.restartCommitted(attempt, initial);
    }
    const handoff = await this.hooks.waitForHandoff(attempt);
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

async function stopServer(server: RunningServer | undefined): Promise<void> {
  if (!server || server.stopped || server.child.exitCode !== null) return;
  server.stopped = true;
  try {
    server.child.kill("SIGTERM");
    await Promise.race([
      once(server.child, "exit"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("server did not stop")), 15_000),
      ),
    ]);
  } catch {
    server.child.kill("SIGKILL");
  }
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

class ManagedUpdateHooks implements UpdateOrchestratorHooks {
  private readonly identity: ProcessIdentityProvider;
  private readonly fs: DurableFileSystem;

  constructor(
    private readonly handoffIdentity: string,
    options: {
      identity?: ProcessIdentityProvider;
      fs?: DurableFileSystem;
    } = {},
  ) {
    this.identity = options.identity ?? new PlatformBootIdentityProvider();
    this.fs = options.fs ?? new NodeDurableFileSystem();
  }

  async inspect(_attempt: UpdateOrchestrationAttempt) {
    return AttemptJournal.inspect(_attempt.installRoot);
  }

  async waitForHandoff(
    attempt: UpdateOrchestrationAttempt,
  ): Promise<AttemptJournalSnapshot> {
    const deadline = Date.now() + (attempt.timeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      const snapshot = await AttemptJournal.inspect(attempt.installRoot);
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
        servicePort: attempt.servicePort,
      },
    );
    let lock: LockHandle | undefined;
    let running: RunningServer | undefined;
    let currentFence = snapshot.fence;
    const journal = await AttemptJournal.open(attempt.installRoot);
    try {
      lock = await recovery.takeoverHandoff({
        owner: actor,
        handoffIdentity: this.handoffIdentity,
      });
      currentFence = lock.fence;
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
        await stopServer(running);
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
        await stopServer(running);
        running = undefined;
        if (lock) {
          await lock.release();
          lock = undefined;
        }
      await recovery.release();
      return {
        state: "committed",
        attemptId: attempt.attemptId,
        fence: currentFence,
        version: prepared.targetVersion,
      };
    } catch (error) {
      await stopServer(running);
      const current = await AttemptJournal.inspect(attempt.installRoot);
      if (current.phase === "COMMITTED") {
        if (lock) await lock.release().catch(() => undefined);
        await recovery.release().catch(() => undefined);
        throw error;
      }
      try {
        const rolledBack = await this.rollback(
          attempt,
          current,
          error instanceof Error ? error.message : "update failed",
        );
        if (lock) await lock.release().catch(() => undefined);
        await recovery.release().catch(() => undefined);
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
    const journal = await AttemptJournal.open(attempt.installRoot);
    const current = snapshot;
    const prepared = preparedUpdate(current);
    const snapshotPayload = latestPayload(snapshot, "snapshot-database");
    if (typeof snapshotPayload.path !== "string") {
      throw new Error("rollback snapshot path is unavailable");
    }
    await new UpdateRollbackService().restoreDatabase({
      root: attempt.installRoot,
      journal,
      attemptId: attempt.attemptId,
      fence: current.fence,
      databasePath: prepared.databasePath,
      snapshotPath: snapshotPayload.path,
    });
    try {
      await new CurrentLinkSwitcher(
        attempt.installRoot,
        journal,
        { fs: this.fs },
      ).recover(await journal.readSnapshot());
    } catch (error) {
      if (!/no recoverable link history/i.test(
        error instanceof Error ? error.message : "",
      )) {
        throw error;
      }
    }
    const rolledBackState = await journal.readSnapshot();
    if (rolledBackState.phase !== "ROLLED_BACK") {
      const intent = await journal.appendIntent({
        attemptId: attempt.attemptId,
        fence: rolledBackState.fence,
        action: "complete-rollback",
        phase: "ROLLED_BACK",
        payload: { reason: "pre-commit-failure" },
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
    const port = attempt.servicePort ?? 8080;
    const environment = await this.serverEnvironment(attempt);
    const currentMain = path.join(current, "apps/server/dist/main.js");
    try {
      await waitForJson(
        `http://127.0.0.1:${port}/api/v1/auth/status`,
        {},
        Date.now() + 500,
        (status) => status === 200,
      );
    } catch {
      const child = spawn(process.execPath, [currentMain], {
        cwd: attempt.installRoot,
        env: environment,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: "ignore",
      });
      child.unref();
      await waitForJson(
        `http://127.0.0.1:${port}/api/v1/auth/status`,
        {},
        Date.now() + (attempt.timeoutMs ?? 120_000),
        (status) => status === 200,
      );
    }
    const journal = await AttemptJournal.open(attempt.installRoot);
    const intent = await journal.appendIntent({
      attemptId: attempt.attemptId,
      fence: snapshot.fence,
      action: "verify-committed-restart",
      phase: "COMMITTED",
      payload: { version: prepared.targetVersion },
    });
    await journal.appendCompletion({
      attemptId: attempt.attemptId,
      fence: snapshot.fence,
      intentId: intent.id,
      phase: "COMMITTED",
      result: { version: prepared.targetVersion, health: "ok" },
    });
    await new RetentionService(attempt.installRoot, {
      fs: this.fs,
    })
      .cleanup(await journal.readSnapshot())
      .catch(() => undefined);
    return {
      state: "committed",
      attemptId: attempt.attemptId,
      fence: snapshot.fence,
      version: prepared.targetVersion,
    };
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
    const environment = await this.serverEnvironment(attempt);
    environment.FILESTATION_HOST = "127.0.0.1";
    environment.FILESTATION_PORT = String(port);
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
      env: environment,
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
    });
    if (!child.stdin) {
      child.kill();
      throw new Error("server startup did not receive an inherited capability pipe");
    }
    const inherited = encodeInheritedCapability(authority);
    try {
      child.stdin.end(inherited);
    } finally {
      inherited.fill(0);
    }
    return {
      child,
      baseUrl: `http://127.0.0.1:${port}`,
      stage,
      stopped: false,
    };
  }

  private async serverEnvironment(
    attempt: UpdateOrchestrationAttempt,
  ): Promise<NodeJS.ProcessEnv> {
    const loaded = await loadInstallEnvironment(attempt.installRoot);
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
}): UpdateOrchestrator {
  return new UpdateOrchestrator(new ManagedUpdateHooks(
    options.handoffIdentity,
    options,
  ));
}
