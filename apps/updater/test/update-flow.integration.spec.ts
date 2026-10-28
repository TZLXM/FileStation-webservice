import { ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import sqlite3 = require("sqlite3");
import { AttemptJournal } from "../src/state/attempt-journal";
import { PlatformBootIdentityProvider } from "../src/state/boot-identity";
import { NodeDurableFileSystem } from "../src/platform/durable-fs";
import { UpdateLock } from "../src/state/update-lock";
import {
  planRequiredSpace,
  recheckRequiredSpace,
  VolumeManifest,
} from "../src/platform/volume-space";

jest.setTimeout(120_000);

const identity = new PlatformBootIdentityProvider();
const durable = new NodeDurableFileSystem();
const sourceRoot = path.resolve(__dirname, "../..");
const fixtureRoot = path.resolve(__dirname, "fixtures");
const compiledRoot = path.resolve(__dirname, "../dist");
const sqliteModulePath = require.resolve("sqlite3");
const capabilityModulePath = path.join(
  compiledRoot,
  "update/capability.js",
);
const attemptJournalModulePath = path.join(
  compiledRoot,
  "state/attempt-journal.js",
);
const durableFsModulePath = path.join(
  compiledRoot,
  "platform/durable-fs.js",
);
const recoveryGuardModulePath = path.join(
  compiledRoot,
  "platform/recovery-guard.js",
);
const orchestratorModulePath = path.join(
  compiledRoot,
  "update/orchestrator.js",
);
const operatorAuthorityModulePath = path.join(
  compiledRoot,
  "update/operator-authority.js",
);
const cliModulePath = path.join(compiledRoot, "cli.js");
const bootstrapSnapshotModulePath = path.resolve(
  __dirname,
  "../../server/dist/bootstrap/bootstrap-snapshot.js",
);

interface SnapshotFixture {
  root: string;
  database: string;
  storage: string;
  temp: string;
  servicePort: number;
  attemptId: string;
  attemptFence: number;
  oldRelease: string;
  stagingRelease: string;
  oldWriter: ChildProcess;
  journal: AttemptJournal;
}

function createHashHex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function allocatePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("failed to allocate fixture port");
  return port;
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs = 30_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      once(child, "exit"),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`fixture process ${child.pid} did not exit`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { code: child.exitCode, signal: child.signalCode };
}

async function sendMessage(
  child: ChildProcess,
  command: string,
  event: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const receive = (message: { event?: string; error?: string }) => {
        child.off("message", receive);
        if (message.error) reject(new Error(message.error));
        else if (message.event === event) resolve();
        else {
          child.once("message", receive);
        }
      };
      child.once("message", receive);
      timer = setTimeout(() => {
        child.off("message", receive);
        reject(new Error(`old writer did not acknowledge ${command}`));
      }, 10_000);
      child.send?.(command);
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForReady(
  child: ChildProcess,
  getErrors: () => string = () => "",
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (message: string) => {
        child.off("message", receive);
        child.off("exit", onExit);
        reject(new Error(`${message}${getErrors() ? `: ${getErrors()}` : ""}`));
      };
      const receive = (message: { event?: string; error?: string }) => {
        child.off("message", receive);
        child.off("exit", onExit);
        if (message.error) reject(new Error(message.error));
        else if (message.event === "ready") resolve();
        else child.once("message", receive);
      };
      const onExit = () => fail("old writer exited before ready");
      child.once("message", receive);
      child.once("exit", onExit);
      timer = setTimeout(() => {
        fail("old writer did not become ready");
      }, 10_000);
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function databaseQuery<T>(
  database: string,
  sql: string,
  parameters: unknown[] = [],
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(
      database,
      sqlite3.OPEN_READONLY,
      (openError) => {
        if (openError) {
          reject(openError);
          return;
        }
        connection.all<T>(sql, parameters, (queryError, rows) => {
          connection.close();
          if (queryError) reject(queryError);
          else resolve(rows);
        });
      },
    );
  });
}

async function writeTemplate(
  templateName: string,
  destination: string,
  replacements: Record<string, string>,
): Promise<void> {
  let source = await readFile(path.join(fixtureRoot, templateName), "utf8");
  for (const [placeholder, value] of Object.entries(replacements)) {
    source = source.replaceAll(placeholder, value);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, source, { mode: 0o600 });
}

async function installRelease(
  releaseRoot: string,
  version: string,
): Promise<void> {
  await mkdir(path.join(releaseRoot, "apps/server/dist"), {
    recursive: true,
  });
  await writeFile(
    path.join(releaseRoot, "package.json"),
    `${JSON.stringify({ name: "@filestation/fixture-release", version })}\n`,
  );
  await writeTemplate(
    "managed-server.cjs",
    path.join(releaseRoot, "apps/server/dist/main.js"),
    {
      __SQLITE3_PATH__: JSON.stringify(sqliteModulePath),
      __CAPABILITY_PATH__: JSON.stringify(capabilityModulePath),
      __ATTEMPT_JOURNAL_PATH__: JSON.stringify(attemptJournalModulePath),
    },
  );
}

async function createFixture(
  options: { holdOldProcess?: boolean } = {},
): Promise<SnapshotFixture> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "filestation-update-flow-")),
  );
  const database = path.join(root, "data/filestation.db");
  const storage = path.join(root, "data/storage");
  const temp = path.join(root, "data/temp");
  const servicePort = await allocatePort();
  const attemptId = "attempt-task11-real-wal";
  await Promise.all([
    mkdir(path.dirname(database), { recursive: true }),
    mkdir(storage, { recursive: true }),
    mkdir(temp, { recursive: true }),
    mkdir(path.join(root, "updater/dist"), { recursive: true }),
    mkdir(path.join(root, "releases"), { recursive: true }),
    mkdir(path.join(root, ".filestation-update-staging/payload"), {
      recursive: true,
    }),
    mkdir(path.join(root, "backups/backup-01"), { recursive: true }),
  ]);

  const oldRelease = path.join(root, "releases/v0.2.5-old");
  const stagingRelease = path.join(
    root,
    ".filestation-update-staging/payload",
  );
  await installRelease(oldRelease, "0.2.5");
  await installRelease(stagingRelease, "0.2.6");
  await durable
    .createJunction(oldRelease, path.join(root, "current"))
    .catch(() => durable.symlink(oldRelease, path.join(root, "current")));
  await writeTemplate(
    "terminal-cli.cjs",
    path.join(root, "updater/dist/cli.js"),
    { __CLI_PATH__: JSON.stringify(cliModulePath) },
  );
  await writeTemplate(
    "updater-worker.cjs",
    path.join(root, "updater-worker.cjs"),
    {
      __ATTEMPT_JOURNAL_PATH__: JSON.stringify(attemptJournalModulePath),
      __DURABLE_FS_PATH__: JSON.stringify(durableFsModulePath),
      __ORCHESTRATOR_PATH__: JSON.stringify(orchestratorModulePath),
      __OPERATOR_AUTHORITY_PATH__: JSON.stringify(operatorAuthorityModulePath),
    },
  );
  const oldWriterFixture = path.join(root, "old-writer.cjs");
  await writeTemplate("old-writer.cjs", oldWriterFixture, {
    __SQLITE3_PATH__: JSON.stringify(sqliteModulePath),
    __RECOVERY_GUARD_PATH__: JSON.stringify(recoveryGuardModulePath),
  });

  const env = [
    "NODE_ENV=production",
    "JWT_SECRET=synthetic-task11-service-secret",
    `FILESTATION_PORT=${servicePort}`,
    "FILESTATION_HOST=127.0.0.1",
    `FILESTATION_DB_PATH=${database}`,
    `FILESTATION_STORAGE_PATH=${storage}`,
    `FILESTATION_TEMP_PATH=${temp}`,
    "FILESTATION_SERVE_STATIC=false",
    "",
  ].join("\n");
  await writeFile(path.join(root, ".env"), env, { mode: 0o600 });
  await chmod(path.join(root, ".env"), 0o600);
  const metadata = {
    schemaVersion: 1,
    installId: "task11-fixture",
    installRoot: root,
    currentPath: path.join(root, "current"),
    environmentPath: path.join(root, ".env"),
    paths: { database, storage, temp },
    bootstrapBackupId: "backup-01",
    bootstrapFingerprint: "a".repeat(64),
    createdAt: new Date().toISOString(),
    productionEnvironment: {
      nodeEnv: "production",
      required: ["NODE_ENV", "JWT_SECRET"],
      source: "dotenv",
    },
  };
  await durable.writeAtomic(
    path.join(root, "managed-install.json"),
    Buffer.from(`${JSON.stringify(metadata)}\n`),
    { mode: 0o600 },
  );

  const oldWriter = spawn(
    process.execPath,
    [
      oldWriterFixture,
      root,
      database,
    ],
    {
      cwd: root,
      env: { ...process.env },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  let writerErrors = "";
  oldWriter.stderr?.on("data", (chunk) => {
    writerErrors += chunk.toString("utf8");
  });
  await waitForReady(oldWriter, () => writerErrors);
  const processCreatedAt = await identity.processCreatedAt(oldWriter.pid!);
  const boot = await identity.current();
  const journal = await AttemptJournal.open(root);
  const lock = await UpdateLock.acquire(
    root,
    {
      attemptId,
      bootIdentity: boot.value,
      pid: oldWriter.pid!,
      processCreatedAt,
      heartbeatAt: new Date().toISOString(),
      currentVersion: "0.2.5",
      targetVersion: "0.2.6",
      previousVersion: "0.2.5",
      backupId: "backup-01",
    },
    { journal },
  );

  const prepare = await journal.appendIntent({
    attemptId,
    fence: lock.fence,
    action: "prepare-update",
    phase: "PREPARED",
    payload: {
      stagingPath: stagingRelease,
      targetVersion: "0.2.6",
      artifactSha256: "b".repeat(64),
      manifestSha256: "c".repeat(64),
      databasePath: database,
    },
  });
  await journal.appendCompletion({
    attemptId,
    fence: lock.fence,
    intentId: prepare.id,
    phase: "PREPARED",
  });
  const maintenance = await journal.appendIntent({
    attemptId,
    fence: lock.fence,
    action: "enter-maintenance",
    phase: "MAINTENANCE",
  });
  await journal.appendCompletion({
    attemptId,
    fence: lock.fence,
    intentId: maintenance.id,
    phase: "MAINTENANCE",
  });

  await sendMessage(oldWriter, "write", "written");
  const walPath = `${database}-wal`;
  expect((await stat(walPath)).size).toBeGreaterThan(0);
  await sendMessage(oldWriter, "drain", "drained");

  const snapshotPath = path.join(
    root,
    "backups/backup-01/update-snapshot.sqlite",
  );
  const { createBootstrapSnapshot } = require(
    bootstrapSnapshotModulePath,
  ) as {
    createBootstrapSnapshot(options: {
      database: string;
      output: string;
    }): Promise<{
      sourceIntegrity: "ok";
      sourceForeignKeys: 0;
      snapshotIntegrity: "ok";
      snapshotForeignKeys: 0;
    }>;
  };
  const snapshotVerification = await createBootstrapSnapshot({
    database,
    output: snapshotPath,
  });
  expect(snapshotVerification).toEqual({
    sourceIntegrity: "ok",
    sourceForeignKeys: 0,
    snapshotIntegrity: "ok",
    snapshotForeignKeys: 0,
  });
  expect(
    await databaseQuery<{ value: string }>(
      snapshotPath,
      "SELECT value FROM items",
    ),
  ).toEqual([{ value: "wal-before-update" }]);
  const snapshotBytes = await readFile(snapshotPath);
  const snapshot = await stat(snapshotPath);
  const snapshotIntent = await journal.appendIntent({
    attemptId,
    fence: lock.fence,
    action: "snapshot-database",
    phase: "SNAPSHOT_READY",
    payload: {
      path: snapshotPath,
      sha256: createHashHex(snapshotBytes),
      bytes: snapshot.size,
      createdAt: new Date().toISOString(),
      integrity: "ok",
      foreignKeys: 0,
    },
  });
  await journal.appendCompletion({
    attemptId,
    fence: lock.fence,
    intentId: snapshotIntent.id,
    phase: "SNAPSHOT_READY",
  });

  const current = await journal.readSnapshot();
  const nextContext = {
    ...structuredClone(current.records.at(-1)!.context),
    phase: "MAINTENANCE" as const,
    owner: {
      ...structuredClone(current.records.at(-1)!.context.owner),
      heartbeatAt: new Date().toISOString(),
      handoffIdentityHash: createHashHex("fixture-handoff"),
    },
  };
  const handoffIdentity = await journal.appendIntent({
    attemptId,
    fence: lock.fence,
    action: "bind-handoff-identity",
    phase: "MAINTENANCE",
    payload: { identityHash: nextContext.owner.handoffIdentityHash },
  });
  await journal.appendCompletion({
    attemptId,
    fence: lock.fence,
    intentId: handoffIdentity.id,
    phase: "MAINTENANCE",
    nextContext,
  });
  const closeIntent = await journal.appendIntent({
    attemptId,
    fence: lock.fence,
    action: "close-application",
    phase: "SNAPSHOT_READY",
  });

  if (!options.holdOldProcess) {
    // The fixture proved the drain barrier before this forced exit. SIGKILL
    // makes the old-process death proof explicit and releases the OS guard.
    oldWriter.kill("SIGKILL");
    await waitForExit(oldWriter);
  }
  if (!options.holdOldProcess && oldWriter.exitCode === null) {
    await waitForExit(oldWriter);
  }
  if (!options.holdOldProcess) {
    await journal.appendCompletion({
      attemptId,
      fence: lock.fence,
      intentId: closeIntent.id,
      phase: "HANDOFF_READY",
    });
  }
  if (writerErrors) throw new Error(writerErrors);
  return {
    root,
    database,
    storage,
    temp,
    servicePort,
    attemptId,
    attemptFence: lock.fence,
    oldRelease,
    stagingRelease,
    oldWriter,
    journal,
  };
}

async function runWorker(
  fixture: SnapshotFixture,
  mode: "forward" | "recovery",
  environment: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; output: string }> {
  const child = spawn(
    process.execPath,
    [
      path.join(fixture.root, "updater-worker.cjs"),
      "--root",
      fixture.root,
      "--attempt",
      fixture.attemptId,
      "--port",
      String(fixture.servicePort),
      mode === "recovery" ? "--recovery" : "--forward",
    ],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        NODE_ENV: "production",
        JWT_SECRET: "synthetic-task11-service-secret",
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  const exit = await waitForExit(child, 60_000);
  return { code: exit.code, output };
}

async function cleanupFixture(fixture: SnapshotFixture): Promise<void> {
  if (
    fixture.oldWriter.exitCode === null &&
    fixture.oldWriter.signalCode === null
  ) {
    fixture.oldWriter.kill("SIGKILL");
    await waitForExit(fixture.oldWriter, 10_000).catch(() => undefined);
  }
  const snapshot = await AttemptJournal.inspect(fixture.root);
  const pids = new Set<number>();
  for (const record of snapshot.records) {
    if (
      record.kind === "completion" &&
      record.result &&
      typeof record.result === "object" &&
      !Array.isArray(record.result) &&
      typeof record.result.pid === "number"
    ) {
      pids.add(record.result.pid);
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
  await rm(fixture.root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

async function expectOldReleaseRunning(
  fixture: SnapshotFixture,
): Promise<void> {
  expect(await realpath(path.join(fixture.root, "current"))).toBe(
    fixture.oldRelease,
  );
  const response = await fetch(
    `http://127.0.0.1:${fixture.servicePort}/fixture/identity`,
  );
  expect(response.ok).toBe(true);
  await expect(response.json()).resolves.toMatchObject({
    status: "ok",
    version: "0.2.5",
  });
}

describe("controlled cross-process update integration", () => {
  it("uses a real WAL snapshot and production fenced handoff through independent committed restart", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(
        path.join(fixture.root, "fixture-promote-drop-once"),
        "drop the first readiness response",
      );
      const worker = await runWorker(fixture, "forward");
      if (worker.code !== 0) {
        const terminalError = await readFile(
          path.join(fixture.root, "fixture-terminal-error.txt"),
          "utf8",
        ).catch(() => "");
        const terminalEnvironment = await readFile(
          path.join(fixture.root, "fixture-terminal-environment.json"),
          "utf8",
        ).catch(() => "");
        const loadedTerminalEnvironment = await readFile(
          path.join(
            fixture.root,
            "fixture-terminal-loaded-environment.json",
          ),
          "utf8",
        ).catch(() => "");
        const validationInput = await readFile(
          path.join(
            fixture.root,
            "fixture-terminal-validation-input.json",
          ),
          "utf8",
        ).catch(() => "");
        const launchInput = await readFile(
          path.join(fixture.root, "fixture-terminal-launch-input.json"),
          "utf8",
        ).catch(() => "");
        const stageError = await readFile(
          path.join(fixture.root, "fixture-stage-error.txt"),
          "utf8",
        ).catch(() => "");
        throw new Error(
          `forward worker failed:\n${worker.output}\n` +
            `terminal:\n${terminalError}\n` +
            `terminal environment:\n${terminalEnvironment}\n` +
            `loaded environment:\n${loadedTerminalEnvironment}\n` +
            `validation input:\n${validationInput}\n` +
            `launch input:\n${launchInput}\n` +
            `stage:\n${stageError}`,
        );
      }
      expect(worker.output).toMatch(/"state":"committed"/);

      const committed = await AttemptJournal.inspect(fixture.root);
      expect(committed).toMatchObject({
        attemptId: fixture.attemptId,
        phase: "COMMITTED",
        pending: null,
        currentVersion: "0.2.5",
        targetVersion: "0.2.6",
        previousVersion: "0.2.5",
      });
      expect(committed.fence).toBeGreaterThan(fixture.attemptFence);
      expect(await realpath(path.join(fixture.root, "current"))).toContain(
        "v0.2.6-",
      );
      const actions = committed.records
        .filter((record) => record.kind === "intent")
        .map((record) => record.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          "prepare-update",
          "enter-maintenance",
          "snapshot-database",
          "bind-handoff-identity",
          "close-application",
          "replace-owner",
          "record-old-stopped",
          "install-release",
          "validate-release",
          "ready-to-commit",
          "commit-update",
          "verify-committed-restart",
        ]),
      );
      const ready = committed.records.find(
        (record) =>
          record.kind === "intent" &&
          record.action === "ready-to-commit",
      );
      expect(ready?.payload).toMatchObject({
        targetVersion: "0.2.6",
        receipt: expect.any(String),
      });
      expect(
        await databaseQuery<{ version: string }>(
          fixture.database,
          "SELECT version FROM update_schema",
        ),
      ).toEqual([{ version: "0.2.6" }]);

      const proof = committed.records
        .filter(
          (record) =>
            record.kind === "completion" &&
            record.phase === "COMMITTED",
        )
        .at(-1)?.result as Record<string, unknown>;
      expect(proof).toMatchObject({
        version: "0.2.6",
        health: "ok",
        pid: expect.any(Number),
        createdAt: expect.any(String),
        boot: expect.any(String),
        nonce: expect.any(String),
      });
      const response = await fetch(
        `http://127.0.0.1:${fixture.servicePort}/fixture/identity`,
      );
      expect(response.ok).toBe(true);
      await expect(response.json()).resolves.toMatchObject({
        status: "ok",
        version: "0.2.6",
        pid: proof.pid,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("rejects takeover while the old PID is still alive", async () => {
    const fixture = await createFixture({ holdOldProcess: true });
    try {
      await fixture.journal.appendCompletion({
        attemptId: fixture.attemptId,
        fence: fixture.attemptFence,
        intentId: fixture.journal
          .readSnapshot
          ? (await fixture.journal.readSnapshot()).pending!.intentId
          : "",
        phase: "HANDOFF_READY",
      });
      const worker = await runWorker(fixture, "forward");
      expect(worker.code).not.toBe(0);
      expect(worker.output).toMatch(/timed out waiting|old update owner/i);
      expect(await AttemptJournal.inspect(fixture.root)).toMatchObject({
        phase: "HANDOFF_READY",
        fence: fixture.attemptFence,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("does not create a snapshot after a disk-space recheck fails with a real WAL", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "filestation-wal-space-")),
    );
    const database = path.join(root, "data/filestation.db");
    const writerFixture = path.join(root, "old-writer.cjs");
    await mkdir(path.dirname(database), { recursive: true });
    await writeTemplate("old-writer.cjs", writerFixture, {
      __SQLITE3_PATH__: JSON.stringify(sqliteModulePath),
      __RECOVERY_GUARD_PATH__: JSON.stringify(recoveryGuardModulePath),
    });
    const writer = spawn(
      process.execPath,
      [writerFixture, root, database],
      {
        cwd: root,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        windowsHide: true,
      },
    );
    try {
      await waitForReady(writer);
      await sendMessage(writer, "write", "written");
      const wal = `${database}-wal`;
      expect((await stat(wal)).size).toBeGreaterThan(0);
      const pageCount = await databaseQuery<{ page_count: number }>(
        database,
        "PRAGMA page_count",
      );
      const pageSize = await databaseQuery<{ page_size: number }>(
        database,
        "PRAGMA page_size",
      );
      const snapshotPath = path.join(root, "backups/pre-update.sqlite");
      const paths = {
        installRoot: root,
        artifactStaging: path.join(root, ".staging"),
        releases: path.join(root, "releases"),
        retainedRelease: path.join(root, "releases/0.2.5"),
        database,
        wal,
        shm: `${database}-shm`,
        temp: path.join(root, "data/temp"),
        backups: path.join(root, "backups"),
        snapshot: snapshotPath,
        restoreTemp: path.join(root, "data/restore.sqlite"),
      };
      const currentPlatform: "windows-x64" | "linux-x64" =
        process.platform === "win32" ? "windows-x64" : "linux-x64";
      const manifest: VolumeManifest = {
        database_migration: true,
        migration_workspace_multiplier: 2,
        migration_workspace_min_bytes: 256 * 1024 * 1024,
        artifacts: [
          {
            platform: currentPlatform,
            archive_size: 1_000,
            unpacked_size: 4_000,
          },
        ],
      };
      const metrics = {
        pageCount: pageCount[0].page_count,
        pageSize: pageSize[0].page_size,
        dbFileBytes: (await stat(database)).size,
        walBytes: (await stat(wal)).size,
        shmBytes: (await stat(`${database}-shm`)).size,
        snapshotBytes: 0,
      };
      const options = {
        resolveVolumeId: async () => "same-volume",
        minimumSafetyMarginBytes: 64 * 1024 * 1024,
        retainedReleaseBytes: 4_000,
        artifactPlatform: currentPlatform,
      };
      const initial = await planRequiredSpace(
        paths,
        manifest,
        metrics,
        {
          ...options,
          readAvailableBytes: async () => 1024 * 1024 * 1024,
        },
      );
      expect(initial).toHaveLength(1);
      expect(initial[0].sufficient).toBe(true);
      const recheck = await recheckRequiredSpace(
        paths,
        manifest,
        { ...metrics, walBytes: metrics.walBytes + 4096 },
        initial,
        {
          ...options,
          readAvailableBytes: async () => 1,
        },
      );
      expect(recheck).toMatchObject({ changed: true, sufficient: false });
      expect(recheck.plan[0].components).toContainEqual(
        expect.objectContaining({
          name: "database-wal",
          bytes: metrics.walBytes + 4096,
        }),
      );
      await expect(stat(snapshotPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      if (writer.exitCode === null) writer.kill("SIGKILL");
      await waitForExit(writer, 10_000).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["migration", "fixture-migration-failure"],
    ["validation health", "fixture-health-failure"],
  ])("restores the verified snapshot after %s failure", async (_label, file) => {
    const fixture = await createFixture();
    try {
      await writeFile(path.join(fixture.root, file), "fail");
      const worker = await runWorker(fixture, "forward");
      if (worker.code !== 0) {
        throw new Error(`failure worker did not recover:\n${worker.output}`);
      }
      expect(worker.output).toMatch(/"state":"rolled_back"/);
      const state = await AttemptJournal.inspect(fixture.root);
      expect(state).toMatchObject({
        phase: "ROLLED_BACK",
        pending: null,
      });
      await expectOldReleaseRunning(fixture);
      expect(
        await databaseQuery<{ name: string }>(
          fixture.database,
          "SELECT name FROM sqlite_master WHERE name = 'update_schema'",
        ),
      ).toEqual([]);
      expect(
        await databaseQuery<{ value: string }>(
          fixture.database,
          "SELECT value FROM items",
        ),
      ).toEqual([{ value: "wal-before-update" }]);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("keeps rollback fail closed when terminal startup fails, then recovers it", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(
        path.join(fixture.root, "fixture-health-failure"),
        "fail validation health",
      );
      await writeFile(
        path.join(fixture.root, "fixture-rollback-start-failure"),
        "fail old release startup",
      );
      const failed = await runWorker(fixture, "forward");
      expect(failed.code).not.toBe(0);
      const blocked = await AttemptJournal.inspect(fixture.root);
      expect(blocked.phase).toBe("ROLLED_BACK");
      expect(blocked.pending?.action).toBe("launch-terminal");
      expect(await realpath(path.join(fixture.root, "current"))).toBe(
        fixture.oldRelease,
      );
      await rm(
        path.join(fixture.root, "fixture-rollback-start-failure"),
      );
      const recovered = await runWorker(fixture, "recovery");
      if (recovered.code !== 0) {
        throw new Error(`rollback recovery failed:\n${recovered.output}`);
      }
      expect(await AttemptJournal.inspect(fixture.root)).toMatchObject({
        phase: "ROLLED_BACK",
        pending: null,
      });
      await expectOldReleaseRunning(fixture);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("recovers a crashed updater from the durable stale attempt", async () => {
    const fixture = await createFixture();
    try {
      const crashed = await runWorker(fixture, "forward", {
        FIXTURE_CRASH_ACTION: "validate-release:intent",
      });
      expect(crashed.code).toBe(73);
      const stale = await AttemptJournal.inspect(fixture.root);
      expect(stale.pending?.action).toBe("validate-release");
      expect(stale.phase).toBe("MIGRATING");
      const recovered = await runWorker(fixture, "recovery");
      if (recovered.code !== 0) {
        throw new Error(`stale attempt recovery failed:\n${recovered.output}`);
      }
      expect(await AttemptJournal.inspect(fixture.root)).toMatchObject({
        phase: "ROLLED_BACK",
        pending: null,
      });
      await expectOldReleaseRunning(fixture);
      expect(
        await databaseQuery<{ value: string }>(
          fixture.database,
          "SELECT value FROM items",
        ),
      ).toEqual([{ value: "wal-before-update" }]);
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
