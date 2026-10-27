import { lstat, mkdir, readdir, readlink, rm } from "node:fs/promises";
import path from "node:path";
import {
  CurrentLinkAmbiguousError,
  CurrentLinkSwitcher,
} from "./current-link";
import { makeJournal } from "../test-support";
import { context, createTempRoot, InjectableDurableFs } from "../test-support";

describe("CurrentLinkSwitcher", () => {
  const winTest = process.platform === "win32" ? it : it.skip;
  const posixTest = process.platform !== "win32" ? it : it.skip;

  winTest(
    "switches a real Windows junction and preserves the previous release",
    async () => {
      const temp = await createTempRoot();
      try {
        const root = temp.path;
        const oldTarget = path.join(root, "releases", "0.2.0");
        const newTarget = path.join(root, "releases", "0.2.5");
        await mkdir(oldTarget, { recursive: true });
        await mkdir(newTarget, { recursive: true });
        await mkdir(path.join(root, "releases", "0.1.0"), { recursive: true });
        await new (await import("./durable-fs")).NodeDurableFileSystem().createJunction(
          oldTarget,
          path.join(root, "current"),
        );
        const journal = await makeJournal(root);
        await journal.beginAttempt(context({ phase: "OLD_STOPPED" }));
        const switcher = new CurrentLinkSwitcher(root, journal, {
          platform: "win32",
        });
        const result = await switcher.switchTo(newTarget, {
          attemptId: "attempt-01",
          fence: 1,
        });
        expect(result).toMatchObject({
          state: "completed",
          target: newTarget,
        });
        expect(path.resolve(await readlink(path.join(root, "current")))).toBe(
          path.resolve(newTarget),
        );
        const previous = (await readdir(path.join(root, "releases"))).find(
          (entry) => entry.startsWith("previous-attempt-"),
        );
        expect(previous).toBeDefined();
        expect(
          path.resolve(
            await readlink(path.join(root, "releases", previous as string)),
          ),
        ).toBe(path.resolve(oldTarget));
      } finally {
        await temp.cleanup();
      }
    },
  );

  winTest(
    "recovers each unique Windows crash-point result without guessing",
    async () => {
      for (const crash of [
        ...["stage-current-link", "detach-current", "attach-current"].flatMap(action => ["after-intent", "after-action", "after-completion"].map(when => ({ action, when }))),
      ] as const) {
        const temp = await createTempRoot();
        try {
          const root = temp.path;
          const oldTarget = path.join(root, "releases", "0.2.0");
          const newTarget = path.join(root, "releases", "0.2.5");
          await mkdir(oldTarget, { recursive: true });
          await mkdir(newTarget, { recursive: true });
          await mkdir(path.join(root, "releases", "0.1.0"), {
            recursive: true,
          });
          const fs = new (await import("./durable-fs")).NodeDurableFileSystem();
          await fs.createJunction(oldTarget, path.join(root, "current"));
          const journal = await makeJournal(root);
          await journal.beginAttempt(context({ phase: "OLD_STOPPED" }));
          const switcher = new CurrentLinkSwitcher(root, journal, {
            platform: "win32",
          });

          await expect(
            switcher.switchTo(
              newTarget,
              { attemptId: "attempt-01", fence: 1 },
              { crashAt: crash as any },
            ),
          ).rejects.toThrow(/injected crash/i);

          const snapshot = await journal.readSnapshot();
          const recovery = await switcher.recover(snapshot);
          const repeated = await switcher.recover(await journal.readSnapshot());
          expect(repeated.target).toBe(recovery.target);
          expect(recovery.failClosed).toBe(false);
          expect(["completed", "restored"]).toContain(recovery.state);
          const currentTarget = path.resolve(
            await readlink(path.join(root, "current")),
          );
          expect(
            currentTarget === path.resolve(newTarget) ||
              currentTarget === path.resolve(oldTarget),
          ).toBe(true);
          expect((await lstat(path.join(root, "current"))).isSymbolicLink()).toBe(
            true,
          );
        } finally {
          await temp.cleanup();
        }
      }
    },
    60000,
  );

  posixTest(
    "uses a same-directory temporary symlink and atomic rename on POSIX",
    async () => {
      const temp = await createTempRoot();
      try {
        const root = temp.path;
        const oldTarget = path.join(root, "releases", "0.2.0");
        const newTarget = path.join(root, "releases", "0.2.5");
        await mkdir(oldTarget, { recursive: true });
        await mkdir(newTarget, { recursive: true });
        const fs = new (await import("./durable-fs")).NodeDurableFileSystem();
        await fs.symlink(oldTarget, path.join(root, "current"));
        const journal = await makeJournal(root);
        await journal.beginAttempt(context({ phase: "OLD_STOPPED" }));
        const switcher = new CurrentLinkSwitcher(root, journal, {
          platform: "linux",
        });
        const result = await switcher.switchTo(newTarget, {
          attemptId: "attempt-01",
          fence: 1,
        });
        expect(result.state).toBe("completed");
        expect(path.resolve(await readlink(path.join(root, "current")))).toBe(
          path.resolve(newTarget),
        );
      } finally {
        await temp.cleanup();
      }
    },
  );

  it("fails closed when an intermediate Windows filesystem matrix is ambiguous", async () => {
    const temp = await createTempRoot();
    try {
      const root = temp.path;
      const journal = await makeJournal(root);
      await journal.beginAttempt(context({ phase: "OLD_STOPPED" }));
      await journal.appendIntent({
        attemptId: "attempt-01",
        fence: 1,
        action: "detach-current",
        phase: "SWITCH_INTENT",
        payload: {
          platform: "win32",
          target: path.join(root, "releases", "0.2.5"),
          originalTarget: path.join(root, "releases", "0.2.0"),
          current: path.join(root, "current"),
          stage: path.join(root, "releases", ".stage-attempt-01"),
          previous: path.join(root, "releases", "previous-attempt-01"),
        },
      });
      const switcher = new CurrentLinkSwitcher(root, journal, {
        platform: "win32",
      });
      await expect(switcher.recover(await journal.readSnapshot())).rejects.toBeInstanceOf(
        CurrentLinkAmbiguousError,
      );
    } finally {
      await temp.cleanup();
    }
  });
});

const realWinTest = process.platform === "win32" ? it : it.skip;
realWinTest("recovers crashes during every recovery-generated intent, action and completion", async () => {
  for (const original of ["stage-current-link", "detach-current"] as const) {
    for (const recoveryAction of original === "detach-current" ? ["restore-previous", "cleanup-staged-link"] : ["cleanup-staged-link"]) {
      for (const boundary of ["intent", "action", "completion"] as const) {
        const temp = await createTempRoot();
        try {
          const fs = new InjectableDurableFs(); const root = temp.path;
          const old = path.join(root, "old"); const next = path.join(root, "new");
          await mkdir(old); await mkdir(next); await fs.createJunction(old, path.join(root, "current"));
          const journal = await makeJournal(root, fs); await journal.beginAttempt(context({ phase: "OLD_STOPPED" }));
          const switcher = new CurrentLinkSwitcher(root, journal, { fs, platform: "win32" });
          await expect(switcher.switchTo(next, { attemptId: "attempt-01", fence: 1 }, { crashAt: { action: original, when: "after-action" } })).rejects.toThrow(/injected/);
          const append = fs.append.bind(fs); const rename = fs.rename.bind(fs); const unlink = fs.unlink.bind(fs);
          let armed = true; let active = false;
          fs.append = async (name, bytes, options) => {
            const record = JSON.parse(bytes.toString());
            if (record.kind === "intent" && record.action === recoveryAction) active = true;
            await append(name, bytes, options);
            if (armed && active && ((boundary === "intent" && record.kind === "intent") || (boundary === "completion" && record.kind === "completion"))) { armed = false; throw new Error("recovery crash"); }
          };
          fs.rename = async (...args) => { await rename(...args); if (armed && active && boundary === "action") { armed = false; throw new Error("recovery crash"); } };
          fs.unlink = async (...args) => { await unlink(...args); if (armed && active && boundary === "action") { armed = false; throw new Error("recovery crash"); } };
          await expect(switcher.recover(await journal.readSnapshot())).rejects.toThrow("recovery crash");
          const reopened = await makeJournal(root);
          const restart = new CurrentLinkSwitcher(root, reopened);
          expect(await restart.recover(await reopened.readSnapshot())).toMatchObject({ state: "restored", target: old });
          expect(await restart.recover(await reopened.readSnapshot())).toMatchObject({ state: "restored", target: old });
        } finally { await temp.cleanup(); }
      }
    }
  }
}, 60000);

it("does not act or complete after an actual intent flush boundary fails", async () => {
  const temp = await createTempRoot();
  try {
    const fs = new InjectableDurableFs(); const journal = await makeJournal(temp.path, fs);
    await journal.beginAttempt(context({ phase: "OLD_STOPPED" }));
    const old = path.join(temp.path, "old"); const next = path.join(temp.path, "next");
    await mkdir(old); await mkdir(next);
    if (process.platform === "win32") await fs.createJunction(old, path.join(temp.path, "current"));
    else await fs.symlink(old, path.join(temp.path, "current"));
    fs.failAfterWriteOperation = "append:update-attempt.journal";
    const switcher = new CurrentLinkSwitcher(temp.path, journal, { fs });
    await expect(switcher.switchTo(next, { attemptId: "attempt-01", fence: 1 })).rejects.toThrow(/native flush boundary/);
    expect((await journal.readSnapshot()).pending?.action).toBe("stage-current-link");
    expect((await journal.readSnapshot()).records.filter(r => r.kind === "completion")).toHaveLength(0);
    expect(path.resolve(await readlink(path.join(temp.path, "current")))).toBe(old);
    expect(await readdir(path.join(temp.path, "releases"))).toEqual([]);
  } finally { await temp.cleanup(); }
});

realWinTest("rejects every ambiguous detach filesystem matrix with a complete payload", async () => {
  for (let mask = 0; mask < 8; mask++) {
    const temp = await createTempRoot();
    try {
      const fs = new InjectableDurableFs(); const old = path.join(temp.path, "old"); const next = path.join(temp.path, "new");
      await mkdir(old); await mkdir(next);
      const payload = { platform: "win32", target: next, originalTarget: old, current: path.join(temp.path, "current"), stage: path.join(temp.path, "stage"), previous: path.join(temp.path, "previous") };
      if (mask & 1) await fs.createJunction(old, payload.current);
      if (mask & 2) await fs.createJunction(next, payload.stage);
      if (mask & 4) await fs.createJunction(old, payload.previous);
      const journal = await makeJournal(temp.path); await journal.beginAttempt(context({ phase: "OLD_STOPPED" }));
      await journal.appendIntent({ attemptId: "attempt-01", fence: 1, phase: "SWITCH_INTENT", action: "detach-current", payload });
      const switcher = new CurrentLinkSwitcher(temp.path, journal);
      if (mask === 3 || mask === 6) expect(await switcher.recover(await journal.readSnapshot())).toMatchObject({ state: "restored", target: old });
      else await expect(switcher.recover(await journal.readSnapshot())).rejects.toBeInstanceOf(CurrentLinkAmbiguousError);
    } finally { await temp.cleanup(); }
  }
}, 60000);
