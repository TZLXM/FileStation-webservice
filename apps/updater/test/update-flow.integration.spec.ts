import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
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
import { stopDetachedChild, DetachedIdentity } from './fixtures/cleanup-process';

jest.setTimeout(120_000);

const identity = new PlatformBootIdentityProvider();
const durable = new NodeDurableFileSystem();
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
const orchestratorModulePath = path.join(
  compiledRoot,
  "update/orchestrator.js",
);
const operatorAuthorityModulePath = path.join(
  compiledRoot,
  "update/operator-authority.js",
);
const cliModulePath = path.join(compiledRoot, "cli.js");

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
  handoffIdentity: string;
  evidence?: Record<string, any>;
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

function messageEvent(child: ChildProcess, event: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`old writer did not emit ${event}`)), 30_000);
    const receive = (message: Record<string, unknown>) => {
      if (message.error) finish(new Error(String(message.error)));
      else if (message.event === event) { clearTimeout(timer); child.off('message', receive); resolve(message); }
    };
    const finish = (error: Error) => { clearTimeout(timer); child.off('message', receive); reject(error); };
    child.on('message', receive);
  });
}

async function sendMessage(child: ChildProcess, command: string, event: string): Promise<Record<string, unknown>> {
  const result = messageEvent(child, event);
  child.send(command);
  return result;
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
  options: { holdOldProcess?: boolean; diskFull?: boolean } = {},
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
    __TYPEORM_PATH__: JSON.stringify(require.resolve('typeorm')),
    __SERVER_DIST__: JSON.stringify(path.resolve(__dirname, '../../server/dist')),
    __UPDATER_DIST__: JSON.stringify(compiledRoot),
    __PACKAGER_URL__: JSON.stringify(require('node:url').pathToFileURL(path.resolve(__dirname, '../../../scripts/release/package-artifact.mjs')).href),
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
      ...(options.diskFull ? ['--disk-full'] : []),
      ...(options.holdOldProcess ? ['--hold-old'] : []),
    ],
    {
      cwd: root,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  let writerErrors = "";
  oldWriter.stdout?.resume();
  oldWriter.stderr?.on("data", (chunk) => {
    writerErrors += chunk.toString("utf8");
  });
  try {
    await waitForReady(oldWriter, () => writerErrors);
    const journal = await AttemptJournal.open(root);
    const maintenance = await sendMessage(oldWriter, 'install', 'maintenance');
    expect(maintenance).toMatchObject({ active: 1, accepting: false });
    const blocked = await sendMessage(oldWriter, 'probe', 'blocked');
    expect(blocked).toMatchObject({ active: 1, admissionRejected: true, snapshots: 0, freezes: 0 });
    await expect(stat(path.join(root, 'backups/update-backup-01/update-snapshot.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
    const failure = options.diskFull ? messageEvent(oldWriter, 'failed') : undefined;
    const handoff = !options.diskFull ? messageEvent(oldWriter, 'handoff') : undefined;
    await sendMessage(oldWriter, 'release', 'released');
    let handoffIdentity = '';
    if (failure) {
      await failure;
    } else {
      handoffIdentity = String((await handoff!).identity);
      if (!options.holdOldProcess) {
        try { await waitForExit(oldWriter); }
        catch (error) {
          const state = await journal.readSnapshot();
          throw new Error(`${error}; old writer: ${JSON.stringify({ exitCode: oldWriter.exitCode, signalCode: oldWriter.signalCode, connected: oldWriter.connected, phase: state.phase, pending: state.pending?.action })}; stderr: ${writerErrors}`);
        }
      }
    }
    const state = await journal.readSnapshot();
    const evidence = !options.holdOldProcess ? JSON.parse(await readFile(path.join(root, 'fixture-prehandoff.json'), 'utf8')) : undefined;
    if (!options.diskFull && !options.holdOldProcess) {
      expect(state.phase).toBe('HANDOFF_READY');
      expect(evidence.events).toEqual(['maintenance', 'lease-write', 'lease-release', 'snapshot', 'freeze', 'spawn', 'close']);
      expect(evidence).toMatchObject({ snapshotLeaseCount: 0, snapshotAccepting: false, frozenSqlRejected: true, frozenStorageRejected: true, closedConnection: true });
      expect(evidence.walAfter).toBeGreaterThan(evidence.walBefore);
      expect(evidence.snapshotWalBytes).toBeGreaterThanOrEqual(evidence.walAfter);
      expect(await databaseQuery(path.join(root, 'backups/update-backup-01/update-snapshot.sqlite'), 'SELECT value FROM items')).toEqual([{ value: 'wal-before-update' }]);
    }
    const lock = { fence: state.fence! };
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
      handoffIdentity,
      evidence,
    };
  } catch (error) {
    if (oldWriter.exitCode === null && oldWriter.signalCode === null) {
      oldWriter.kill('SIGKILL');
      await waitForExit(oldWriter).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    throw error;
  }
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
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdin!.end(fixture.handoffIdentity);
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  try {
    const exit = await waitForExit(child, 60_000);
    return { code: exit.code, output };
  } catch (error) {
    const state = await fixture.journal.readSnapshot();
    const terminal = await readFile(path.join(fixture.root, 'fixture-terminal-error.txt'), 'utf8').catch(() => '');
    const stage = await readFile(path.join(fixture.root, 'fixture-stage-error.txt'), 'utf8').catch(() => '');
    throw new Error(`${error}; updater worker: ${JSON.stringify({ exitCode: child.exitCode, signalCode: child.signalCode, phase: state.phase, pending: state.pending?.action })}; output: ${output}; terminal: ${terminal}; stage: ${stage}`);
  } finally {
    const timing = await readFile(path.join(fixture.root, 'fixture-terminal-timing.jsonl'), 'utf8').catch(() => '');
    if (timing) console.info(`terminal native timing (${mode}):\n${timing}`);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForExit(child).catch(() => undefined);
    }
  }
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
  const children = new Map<string, DetachedIdentity>();
  for (const record of snapshot.records) {
    if (
      record.kind === "completion" &&
      record.result &&
      typeof record.result === "object" &&
      !Array.isArray(record.result) &&
      typeof record.result.pid === "number" &&
      typeof record.result.createdAt === "string" &&
      typeof record.result.boot === "string"
    ) {
      const child = record.result as unknown as DetachedIdentity;
      children.set(`${child.pid}:${child.createdAt}:${child.boot}`, child);
    }
  }
  // Validation/gated children can be recorded in the production ledger before
  // a journal completion exists (e.g. updater crash). It carries the same proof.
  const ledger = await readFile(path.join(fixture.root, 'update.processes.json'), 'utf8').then(text => JSON.parse(text)).catch(() => undefined);
  if (ledger?.attemptId === fixture.attemptId && Array.isArray(ledger.children)) {
    for (const child of ledger.children) {
      if (child && typeof child === 'object') children.set(`${child.pid}:${child.createdAt}:${child.boot}`, child);
    }
  }
  for (const child of children.values()) {
    await stopDetachedChild(child, identity);
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
      });
      // Production acceptance records currentVersion; rollback resolves its
      // previous release from previousVersion ?? currentVersion.
      expect(committed.previousVersion ?? committed.currentVersion).toBe('0.2.5');
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
      const worker = await runWorker(fixture, "forward");
      expect(worker.code).not.toBe(0);
      expect(worker.output).toMatch(/timed out waiting|old update owner/i);
      expect(await AttemptJournal.inspect(fixture.root)).toMatchObject({
        phase: "SNAPSHOT_READY",
        fence: fixture.attemptFence,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('durably aborts a pre-snapshot capacity fault after real WAL growth and drain', async () => {
    const fixture = await createFixture({ diskFull: true });
    try {
      const evidence = fixture.evidence!;
      expect(evidence.walAfter).toBeGreaterThan(evidence.walBefore);
      expect(evidence.preflights).toHaveLength(2);
      expect(evidence.preflights[0]).toMatchObject({ lowCapacity: false, accepting: true });
      expect(evidence.preflights[1]).toMatchObject({ lowCapacity: true, active: 0, accepting: false });
      expect(evidence.preflights[1].walBytes).toBeGreaterThanOrEqual(evidence.walAfter);
      expect(evidence).toMatchObject({ snapshots: 0, freezes: 0, spawns: 0, acceptingAfterFailure: true, frozenAfterFailure: false });
      const state = await fixture.journal.readSnapshot();
      expect(state).toMatchObject({ phase: 'FAILED', pending: null });
      expect(state.records.find(record => record.kind === 'intent' && record.action === 'record-install-failure')?.payload).toMatchObject({ reason: 'PRE_FREEZE_ABORT' });
      expect(state.records.some(record => record.kind === 'intent' && ['snapshot-database', 'install-release', 'validate-release', 'close-application'].includes(record.action ?? ''))).toBe(false);
      await expect(stat(path.join(fixture.root, 'backups/update-backup-01/update-snapshot.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await realpath(path.join(fixture.root, 'current'))).toBe(fixture.oldRelease);
      expect(await databaseQuery(fixture.database, "SELECT name FROM sqlite_master WHERE name = 'update_schema'")).toEqual([]);
      expect(await databaseQuery(fixture.database, 'SELECT value FROM items')).toEqual([{ value: 'wal-before-update' }]);
    } finally { await cleanupFixture(fixture); }
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
      const terminal = state.records.find(record => record.kind === 'intent' && record.action === 'launch-terminal');
      expect(terminal?.payload).toMatchObject({ release: fixture.oldRelease, version: '0.2.5' });
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
