import { lstat, mkdir, readdir, readlink, rm } from "node:fs/promises";
import path from "node:path";
import {
  CurrentLinkAmbiguousError,
  CurrentLinkSwitcher,
} from "./current-link";
import { makeJournal } from "../test-support";
import { context, createTempRoot } from "../test-support";

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
        { action: "stage-current-link", when: "after-intent" as const },
        { action: "detach-current", when: "after-action" as const },
        { action: "attach-current", when: "after-action" as const },
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
              { crashAt: crash },
            ),
          ).rejects.toThrow(/injected crash/i);

          const snapshot = await journal.readSnapshot();
          const recovery = await switcher.recover(snapshot);
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
