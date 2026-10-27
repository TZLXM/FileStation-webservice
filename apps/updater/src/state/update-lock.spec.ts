import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  LockFailure,
  ProcessIdentityProvider,
  UpdateLock,
} from "./update-lock";
import { makeJournal } from "../test-support";
import {
  InjectableDurableFs,
  FIXED_NOW,
  context,
  createTempRoot,
  handoffHash,
} from "../test-support";

const execFileAsync = promisify(execFile);

class TestIdentityProvider implements ProcessIdentityProvider {
  boot = "linux:test-boot";
  readonly created = new Map<number, string>();
  readonly alive = new Set<number>();
  portOwners = new Map<number, number>();

  constructor() {
    this.created.set(100, "created-old");
    this.created.set(200, "created-new");
    this.alive.add(100);
    this.alive.add(200);
  }

  async current() {
    return { provider: "linux-proc" as const, value: this.boot };
  }

  async processCreatedAt(pid: number): Promise<string> {
    const created = this.created.get(pid);
    if (!created) throw new Error(`unknown process ${pid}`);
    return created;
  }

  async isProcessAlive(pid: number, processCreatedAt: string): Promise<boolean> {
    return (
      this.alive.has(pid) &&
      this.created.get(pid) === processCreatedAt
    );
  }

  async listeningPid(port: number): Promise<number | undefined> {
    return this.portOwners.get(port);
  }
}

function owner(
  attemptId: string,
  bootIdentity: string,
  pid: number,
  processCreatedAt: string,
  handoffIdentityHash = handoffHash("handoff-capability"),
) {
  return {
    attemptId,
    bootIdentity,
    pid,
    processCreatedAt,
    heartbeatAt: FIXED_NOW.toISOString(),
    handoffIdentityHash,
    currentVersion: "0.2.0",
    targetVersion: "0.2.5",
    previousVersion: "0.2.0",
    backupId: "backup-01",
  };
}

async function prepareHandoff(
  root: string,
  provider: TestIdentityProvider,
  identity = owner("attempt-01", provider.boot, 100, "created-old"),
  fs = new InjectableDurableFs(),
) {
  const journal = await makeJournal(root, fs);
  const lock = await UpdateLock.acquire(root, identity, {
    fs,
    journal,
    identityProvider: provider,
    servicePort: 18080,
  });
  const intent = await journal.appendIntent({
    attemptId: "attempt-01",
    fence: lock.fence,
    action: "shutdown-handoff",
    phase: "HANDOFF_READY",
    payload: { closed: true },
  });
  await journal.appendCompletion({
    attemptId: "attempt-01",
    fence: lock.fence,
    intentId: intent.id,
    phase: "HANDOFF_READY",
    result: { closed: true },
  });
  return { journal, lock };
}

describe("UpdateLock", () => {
  const handles: Array<{ release(): Promise<void> }> = [];
  const acquireRecovery = UpdateLock.acquireRecovery.bind(UpdateLock);
  beforeEach(() => { jest.spyOn(UpdateLock, "acquireRecovery").mockImplementation(async (...args) => { const handle = await acquireRecovery(...args); handles.push(handle); return handle; }); });
  afterEach(async () => { for (const handle of handles.splice(0)) await handle.release().catch(() => {}); jest.restoreAllMocks(); });
  it("uses exclusive creation so concurrent owners cannot both acquire", async () => {
    const temp = await createTempRoot();
    try {
      const provider = new TestIdentityProvider();
      const journal = await makeJournal(temp.path);
      const attempts = await Promise.allSettled([
        UpdateLock.acquire(
          temp.path,
          owner("attempt-01", provider.boot, 100, "created-old"),
          { journal, identityProvider: provider, servicePort: 18080 },
        ),
        UpdateLock.acquire(
          temp.path,
          owner("attempt-02", provider.boot, 200, "created-new"),
          { journal, identityProvider: provider, servicePort: 18080 },
        ),
      ]);
      expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(
        1,
      );
      expect(attempts.find((result) => result.status === "rejected")).toMatchObject(
        {
          reason: expect.any(LockFailure),
        },
      );
    } finally {
      for (const handle of handles.splice(0)) await handle.release().catch(() => {});
      await temp.cleanup();
    }
  });

  it("starts a later attempt with the next journal fence after terminal release", async () => {
    const temp = await createTempRoot();
    try {
      const provider = new TestIdentityProvider();
      const journal = await makeJournal(temp.path);
      const firstOwner = owner(
        "attempt-01",
        provider.boot,
        100,
        "created-old",
      );
      const first = await UpdateLock.acquire(temp.path, firstOwner, {
        journal,
        identityProvider: provider,
        servicePort: 18080,
      });
      const intent = await journal.appendIntent({
        attemptId: "attempt-01",
        fence: first.fence,
        action: "promote-update",
        phase: "READY_TO_COMMIT",
        payload: {},
      });
      await journal.appendCompletion({
        attemptId: "attempt-01",
        fence: first.fence,
        intentId: intent.id,
        phase: "COMMITTED",
        result: {},
      });
      await first.release();

      const second = await UpdateLock.acquire(
        temp.path,
        owner("attempt-02", provider.boot, 200, "created-new"),
        { journal, identityProvider: provider, servicePort: 18080 },
      );
      expect(second.fence).toBe(2);
      expect(await journal.readSnapshot()).toMatchObject({
        attemptId: "attempt-02",
        fence: 2,
        phase: "PREPARED",
      });
    } finally {
      for (const handle of handles.splice(0)) await handle.release().catch(() => {});
      await temp.cleanup();
    }
  });

  it("requires a matching handoff identity and proven old-process exit before takeover", async () => {
    const temp = await createTempRoot();
    try {
      const provider = new TestIdentityProvider();
      const { journal, lock } = await prepareHandoff(temp.path, provider);
      const recovery = await UpdateLock.acquireRecovery(
        temp.path,
        owner("attempt-01", provider.boot, 200, "created-new"),
        { journal, identityProvider: provider, servicePort: 18080 },
      );

      await expect(
        recovery.takeoverHandoff({
          owner: owner("attempt-01", provider.boot, 200, "created-new"),
          handoffIdentity: "wrong-capability",
        }),
      ).rejects.toBeInstanceOf(LockFailure);
      expect((await journal.readSnapshot()).fence).toBe(lock.fence);

      await expect(
        recovery.takeoverHandoff({
          owner: owner("attempt-01", provider.boot, 200, "created-new"),
          handoffIdentity: "handoff-capability",
        }),
      ).rejects.toThrow(/old owner.*alive/i);

      provider.alive.delete(100);
      const replacement = await recovery.takeoverHandoff({
        owner: owner("attempt-01", provider.boot, 200, "created-new"),
        handoffIdentity: "handoff-capability",
      });
      expect(replacement.fence).toBe(lock.fence + 1);
      await expect(lock.heartbeat()).rejects.toBeInstanceOf(LockFailure);
      await expect(
        journal.appendIntent({
          attemptId: "attempt-01",
          fence: lock.fence,
          action: "late-old-owner",
          phase: "SWITCH_INTENT",
          payload: {},
        }),
      ).rejects.toThrow(/fence/i);
    } finally {
      for (const handle of handles.splice(0)) await handle.release().catch(() => {});
      await temp.cleanup();
    }
  });

  it("treats a reused PID as different only when creation identity differs", async () => {
    const temp = await createTempRoot();
    try {
      const provider = new TestIdentityProvider();
      const { journal } = await prepareHandoff(temp.path, provider);
      provider.created.set(100, "reused-pid-created");
      provider.alive.add(100);
      const recovery = await UpdateLock.acquireRecovery(
        temp.path,
        owner("attempt-01", provider.boot, 200, "created-new"),
        { journal, identityProvider: provider, servicePort: 18080 },
      );
      const replacement = await recovery.takeoverHandoff({
        owner: owner("attempt-01", provider.boot, 200, "created-new"),
        handoffIdentity: "handoff-capability",
      });
      expect(replacement.fence).toBe(2);
    } finally {
      for (const handle of handles.splice(0)) await handle.release().catch(() => {});
      await temp.cleanup();
    }
  });

  it("fails closed on boot mismatch, unavailable identity, or the old owner still holding the port", async () => {
    const temp = await createTempRoot();
    try {
      const provider = new TestIdentityProvider();
      const { journal } = await prepareHandoff(temp.path, provider);
      provider.alive.delete(100);
      provider.portOwners.set(18080, 100);
      const recovery = await UpdateLock.acquireRecovery(
        temp.path,
        owner("attempt-01", provider.boot, 200, "created-new"),
        { journal, identityProvider: provider, servicePort: 18080 },
      );
      await expect(
        recovery.takeoverHandoff({
          owner: owner("attempt-01", provider.boot, 200, "created-new"),
          handoffIdentity: "handoff-capability",
        }),
      ).rejects.toThrow(/port|alive/i);

      provider.portOwners.clear();
      provider.boot = "linux:different-boot";
      await expect(
        recovery.takeoverHandoff({
          owner: owner("attempt-01", provider.boot, 200, "created-new"),
          handoffIdentity: "handoff-capability",
        }),
      ).rejects.toThrow(/boot/i);
    } finally {
      for (const handle of handles.splice(0)) await handle.release().catch(() => {});
      await temp.cleanup();
    }
  });

  it("allows takeover when an unrelated process owns the service port after the old owner exits", async () => {
    const temp = await createTempRoot();
    try {
      const provider = new TestIdentityProvider();
      const { journal } = await prepareHandoff(temp.path, provider);
      provider.alive.delete(100);
      provider.portOwners.set(18080, 999);
      const recovery = await UpdateLock.acquireRecovery(
        temp.path,
        owner("attempt-01", provider.boot, 200, "created-new"),
        { journal, identityProvider: provider, servicePort: 18080 },
      );
      const replacement = await recovery.takeoverHandoff({
        owner: owner("attempt-01", provider.boot, 200, "created-new"),
        handoffIdentity: "handoff-capability",
      });
      expect(replacement.fence).toBe(2);
    } finally {
      for (const handle of handles.splice(0)) await handle.release().catch(() => {});
      await temp.cleanup();
    }
  });

  it.each([
    {
      name: "after owner intent before lock replacement",
      arm(fs: InjectableDurableFs) {
        fs.failRename = {
          match: (source) => source.includes("update.lock.next-"),
        };
      },
    },
    {
      name: "after lock replacement before journal completion",
      arm(fs: InjectableDurableFs) {
        fs.failAppend = {
          timing: "before",
          match: (bytes) =>
            bytes.toString("utf8").includes('"kind":"completion"') &&
            bytes.toString("utf8").includes('"handedOff":true'),
        };
      },
    },
  ])(
    "recovers owner replacement $name",
    async ({ arm }) => {
      const temp = await createTempRoot();
      try {
        const provider = new TestIdentityProvider();
        const fs = new InjectableDurableFs();
        const { journal } = await prepareHandoff(
          temp.path,
          provider,
          owner("attempt-01", provider.boot, 100, "created-old"),
          fs,
        );
        provider.alive.delete(100);
        const nextOwner = owner(
          "attempt-01",
          provider.boot,
          200,
          "created-new",
        );
        const recovery = await UpdateLock.acquireRecovery(
          temp.path,
          nextOwner,
          { journal, fs, identityProvider: provider, servicePort: 18080 },
        );
        arm(fs);
        await expect(
          recovery.takeoverHandoff({
            owner: nextOwner,
            handoffIdentity: "handoff-capability",
          }),
        ).rejects.toThrow(/injected/i);
        expect((await journal.readSnapshot()).pending).toMatchObject({
          action: "replace-owner",
        });

        await recovery.release();
        provider.alive.delete(200); provider.created.set(300, "created-B"); provider.alive.add(300);
        const actualOwner = owner("attempt-01", provider.boot, 300, "created-B");
        const restarted = await UpdateLock.acquireRecovery(temp.path, actualOwner, { journal, fs, identityProvider: provider });
        const replacement = await restarted.takeoverHandoff({
          owner: actualOwner,
          handoffIdentity: "handoff-capability",
        });
        expect(replacement.fence).toBeGreaterThan(2);
        const recovered = await journal.readSnapshot();
        expect(recovered).toMatchObject({
          fence: replacement.fence,
          pending: null,
          owner: {
            pid: 300,
            processCreatedAt: "created-B",
          },
        });
      } finally {
        for (const handle of handles.splice(0)) await handle.release().catch(() => {});
      await temp.cleanup();
      }
    },
  );

  it("serializes stale recovery-lock reclaim and lets exactly one process win", async () => {
    const temp = await createTempRoot();
    try {
      const provider = new TestIdentityProvider();
      const { journal } = await prepareHandoff(temp.path, provider);
      const deadRecovery = await UpdateLock.acquireRecovery(
        temp.path,
        owner("attempt-01", provider.boot, 100, "created-old"),
        { journal, identityProvider: provider, servicePort: 18080 },
      );
      expect(deadRecovery.fence).toBe(1);
      provider.alive.delete(100);
      await deadRecovery.release();
      // Simulate a retained stale record without its process/OS guard.
      const staleBytes = await readFile(path.join(temp.path, "update.lock"));
      const stale = JSON.parse(staleBytes.toString()); stale.kind = "recovery";
      const { checksum: ignored, ...base } = stale;
      stale.checksum = require("node:crypto").createHash("sha256").update(JSON.stringify(base)).digest("hex");
      await require("node:fs/promises").writeFile(path.join(temp.path, "update.recovery.lock"), JSON.stringify(stale));
      provider.created.set(300, "created-new"); provider.alive.add(300);

      const results = await Promise.allSettled([
        UpdateLock.acquireRecovery(
          temp.path,
          owner("attempt-01", provider.boot, 200, "created-new"),
          { journal, identityProvider: provider, servicePort: 18080 },
        ),
        UpdateLock.acquireRecovery(
          temp.path,
          owner("attempt-01", provider.boot, 300, "created-new"),
          { journal, identityProvider: provider, servicePort: 18080 },
        ),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
        1,
      );
    } finally {
      for (const handle of handles.splice(0)) await handle.release().catch(() => {});
      await temp.cleanup();
    }
  });

  it("serializes two eligible contenders that inspect the same stale generation", async () => {
    const temp = await createTempRoot();
    try {
      const provider = new TestIdentityProvider(); provider.created.set(300, "created-B"); provider.alive.add(300);
      const fs = new InjectableDurableFs(); const { journal } = await prepareHandoff(temp.path, provider, undefined, fs);
      const stale = await UpdateLock.acquireRecovery(temp.path, owner("attempt-01", provider.boot, 100, "created-old"), { fs, journal, identityProvider: provider });
      const stalePath = path.join(temp.path, "update.recovery.lock");
      const saved = await readFile(stalePath); await stale.release();
      await require("node:fs/promises").writeFile(stalePath, saved); provider.alive.delete(100);
      const read = fs.readFile.bind(fs); let reads = 0; let release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      fs.readFile = async filename => {
        const bytes = await read(filename);
        if (filename === stalePath && ++reads <= 2) { if (reads === 2) release(); await barrier; }
        return bytes;
      };
      let firstCreated!: () => void;
      const created = new Promise<void>(resolve => { firstCreated = resolve; });
      const rename = fs.rename.bind(fs); const create = fs.createExclusive.bind(fs); let renames = 0;
      fs.rename = async (...args) => { if (args[0] === stalePath && ++renames > 1) await created; await rename(...args); };
      fs.createExclusive = async (...args) => { await create(...args); if (args[0] === stalePath) firstCreated(); };
      const contenders = [owner("attempt-01", provider.boot, 200, "created-new"), owner("attempt-01", provider.boot, 300, "created-B")];
      const results = await Promise.allSettled(contenders.map(actor => UpdateLock.acquireRecovery(temp.path, actor, { fs, journal, identityProvider: provider }).catch(error => { release(); throw error; })));
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      const winner = JSON.parse((await read(stalePath)).toString());
      expect(provider.alive.has(winner.owner.pid)).toBe(true);
      const archives = (await require("node:fs/promises").readdir(temp.path)).filter((name: string) => name.startsWith("update.recovery.lock.stale-"));
      expect(archives).toHaveLength(1); expect(archives[0]).toContain("stale-100-");
    } finally { for (const handle of handles.splice(0)) await handle.release().catch(() => {}); await temp.cleanup(); }
  });

  it("releases the OS guard after a crash between quarantine and replacement", async () => {
    const temp = await createTempRoot();
    try {
      const provider = new TestIdentityProvider(); const fs = new InjectableDurableFs();
      const { journal } = await prepareHandoff(temp.path, provider, undefined, fs);
      const stale = await UpdateLock.acquireRecovery(temp.path, owner("attempt-01", provider.boot, 100, "created-old"), { fs, journal, identityProvider: provider });
      const stalePath = path.join(temp.path, "update.recovery.lock"); const bytes = await readFile(stalePath);
      await stale.release(); await require("node:fs/promises").writeFile(stalePath, bytes); provider.alive.delete(100);
      const create = fs.createExclusive.bind(fs); let armed = true;
      fs.createExclusive = async (...args) => { if (armed && args[0] === stalePath) { armed = false; throw new Error("crash after quarantine"); } await create(...args); };
      const actor = owner("attempt-01", provider.boot, 200, "created-new");
      await expect(UpdateLock.acquireRecovery(temp.path, actor, { fs, journal, identityProvider: provider })).rejects.toThrow("crash after quarantine");
      const recovered = await UpdateLock.acquireRecovery(temp.path, actor, { fs, journal, identityProvider: provider });
      expect(recovered.fence).toBe(1);
    } finally { for (const handle of handles.splice(0)) await handle.release().catch(() => {}); await temp.cleanup(); }
  });

  it("repairs a partial tail only after proving the writer exited under recovery ownership", async () => {
    const temp = await createTempRoot();
    try {
      const provider = new TestIdentityProvider(); const { journal } = await prepareHandoff(temp.path, provider);
      const actor = owner("attempt-01", provider.boot, 200, "created-new");
      const recovery = await UpdateLock.acquireRecovery(temp.path, actor, { journal, identityProvider: provider });
      const filename = path.join(temp.path, "update-attempt.journal");
      await require("node:fs/promises").appendFile(filename, '{"partial":');
      await expect(recovery.repairJournalTail()).rejects.toThrow(/alive/);
      expect((await readFile(filename, "utf8")).endsWith('{"partial":')).toBe(true);
      provider.alive.delete(100); await recovery.repairJournalTail();
      expect((await readFile(filename, "utf8")).endsWith("\n")).toBe(true);
      expect((await journal.readSnapshot()).phase).toBe("HANDOFF_READY");
      await recovery.takeoverHandoff({ owner: actor, handoffIdentity: "handoff-capability" });
    } finally { for (const handle of handles.splice(0)) await handle.release().catch(() => {}); await temp.cleanup(); }
  });

  it("uses a real cross-process O_EXCL race when ts-node is available", async () => {
    const temp = await createTempRoot();
    try {
      const source = path.resolve(__dirname, "update-lock.ts");
      const register = require.resolve("ts-node/register");
      const script = `
        const { UpdateLock } = require(${JSON.stringify(source)});
        const provider = {
          current: async () => ({ provider: 'linux-proc', value: 'test-boot' }),
          processCreatedAt: async (pid) => 'pid-' + pid,
          isProcessAlive: async (pid, created) => created === 'pid-' + pid,
          listeningPid: async () => undefined,
        };
        const pid = process.pid;
        const owner = {
          attemptId: 'attempt-' + pid,
          bootIdentity: 'test-boot',
          pid,
          processCreatedAt: 'pid-' + pid,
          heartbeatAt: new Date().toISOString(),
          currentVersion: '0.2.0',
          targetVersion: '0.2.5',
          previousVersion: '0.2.0',
        };
        UpdateLock.acquire(${JSON.stringify(temp.path)}, owner, {
          identityProvider: provider,
          servicePort: 18080,
        }).then(
          () => { process.stdout.write('owner'); },
          (error) => { process.stdout.write('lost:' + error.name); process.exitCode = 7; },
        );
      `;
      const children = [0, 1].map(() =>
        execFileAsync(
          process.execPath,
          ["-r", register, "-e", script],
          { env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "true" } },
        ).then(
          () => "owner",
          (error) => String(error.stdout || "lost"),
        ),
      );
      const results = await Promise.all(children);
      expect(results.filter((result) => result === "owner")).toHaveLength(1);
      expect(results.some((result) => result.includes("lost"))).toBe(true);
      expect(await readFile(path.join(temp.path, "update.lock"), "utf8")).toContain(
        '"owner"',
      );
    } finally {
      for (const handle of handles.splice(0)) await handle.release().catch(() => {});
      await temp.cleanup();
    }
  }, 20_000);
});

describe("active attempt recovery", () => {
  it.each(["OLD_STOPPED", "MIGRATING", "ROLLBACK_INTENT", "COMMITTED"] as const)("recovers %s while preserving a pending action", async phase => {
    const temp = await createTempRoot(); let recovery: any;
    try {
      const provider = new TestIdentityProvider();
      const { journal, lock } = await prepareHandoff(temp.path, provider);
      const intent = await journal.appendIntent({ attemptId: "attempt-01", fence: 1, action: "active-operation", phase });
      provider.alive.delete(100);
      const actor = owner("attempt-01", provider.boot, 200, "created-new");
      recovery = await UpdateLock.acquireRecovery(temp.path, actor, { journal, identityProvider: provider });
      const next = await (recovery as any).recoverAttempt({ owner: actor, handoffIdentity: "handoff-capability", expectedFence: 1 });
      expect(next.owner.pid).toBe(200); expect(next.fence).toBeGreaterThan(1);
      const snapshot = await journal.readSnapshot();
      expect(snapshot.phase).toBe(phase); expect(snapshot.pending?.intentId).toBe(intent.id);
      await expect(lock.heartbeat()).rejects.toThrow(/fenc/i);
      await expect(journal.appendCompletion({ attemptId: "attempt-01", fence: 1, intentId: intent.id, phase })).rejects.toThrow(/fence/i);
      await journal.appendCompletion({ attemptId: "attempt-01", fence: next.fence, intentId: intent.id, phase });
      if (phase === "COMMITTED") await expect(journal.appendIntent({ attemptId: "attempt-01", fence: next.fence, action: "restore-database", phase: "ROLLBACK_INTENT" })).rejects.toThrow(/COMMITTED/);
    } finally { await recovery?.release(); await temp.cleanup(); }
  });
});
