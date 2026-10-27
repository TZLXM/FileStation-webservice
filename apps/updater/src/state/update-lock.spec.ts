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

        const replacement = await recovery.takeoverHandoff({
          owner: nextOwner,
          handoffIdentity: "handoff-capability",
        });
        expect(replacement.fence).toBe(2);
        const recovered = await journal.readSnapshot();
        expect(recovered).toMatchObject({
          fence: 2,
          pending: null,
          owner: {
            pid: 200,
            processCreatedAt: "created-new",
          },
        });
      } finally {
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
      await temp.cleanup();
    }
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
      await temp.cleanup();
    }
  }, 20_000);
});
