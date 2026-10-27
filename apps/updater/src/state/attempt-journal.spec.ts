import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AttemptJournal,
  JournalCorruptError,
  JournalFenceError,
  writeStatusProjection,
} from "./attempt-journal";
import {
  InjectableDurableFs,
  context,
  createTempRoot,
  journalPath,
  makeJournal,
  rewriteRecord,
} from "../test-support";

describe("AttemptJournal", () => {
  it("rebuilds authoritative state and a secret-free status projection", async () => {
    const temp = await createTempRoot();
    try {
      const journal = await makeJournal(temp.path);
      await journal.beginAttempt(context());
      const intent = await journal.appendIntent({
        attemptId: "attempt-01",
        fence: 1,
        action: "replace-current",
        phase: "SWITCH_INTENT",
        payload: {
          target: "releases/0.2.5",
          diagnostic: "must-not-project",
        },
      });
      await journal.appendCompletion({
        attemptId: "attempt-01",
        fence: 1,
        intentId: intent.id,
        phase: "CURRENT_SWITCHED",
        result: { target: "releases/0.2.5" },
      });

      const snapshot = await journal.readSnapshot();
      expect(snapshot).toMatchObject({
        initialized: true,
        attemptId: "attempt-01",
        fence: 1,
        phase: "CURRENT_SWITCHED",
        pending: null,
      });
      expect(snapshot.records).toHaveLength(3);

      await journal.writeStatusProjection();
      const statusPath = path.join(temp.path, "update-status.json");
      const statusText = await readFile(statusPath, "utf8");
      expect(JSON.parse(statusText)).toEqual({
        schemaVersion: 1,
        attemptId: "attempt-01",
        fence: 1,
        phase: "CURRENT_SWITCHED",
        currentVersion: "0.2.0",
        targetVersion: "0.2.5",
        previousVersion: "0.2.0",
        backupId: "backup-01",
        updatedAt: "2026-10-27T01:02:03.004Z",
      });
      expect(statusText).not.toContain("handoff-capability");
      expect(statusText).not.toContain("must-not-project");
      expect(statusText).not.toContain("handoffIdentityHash");

      const rebuilt = await writeStatusProjection(temp.path, snapshot);
      expect(await readFile(rebuilt, "utf8")).toBe(statusText);
    } finally {
      await temp.cleanup();
    }
  });

  it("ignores an incomplete tail without rolling back past a dangerous intent", async () => {
    const temp = await createTempRoot();
    try {
      const journal = await makeJournal(temp.path);
      await journal.beginAttempt(context());
      await journal.appendIntent({
        attemptId: "attempt-01",
        fence: 1,
        action: "replace-current",
        phase: "SWITCH_INTENT",
        payload: { target: "releases/0.2.5" },
      });
      await appendFile(
        await journalPath(temp.path),
        '{"schemaVersion":1,"seq":3,"kind":"completion"',
        "utf8",
      );

      const reopened = await makeJournal(temp.path);
      const snapshot = await reopened.readSnapshot();
      expect(snapshot.phase).toBe("SWITCH_INTENT");
      expect(snapshot.pending?.action).toBe("replace-current");
      expect(snapshot.sequence).toBe(2);
      const raw = await readFile(await journalPath(temp.path), "utf8");
      expect(raw.endsWith("\n")).toBe(false);
      expect(raw).toContain('"kind":"completion"');
    } finally {
      await temp.cleanup();
    }
  });

  it("fails closed on a complete-line checksum mismatch", async () => {
    const temp = await createTempRoot();
    try {
      const journal = await makeJournal(temp.path);
      await journal.beginAttempt(context());
      await journal.appendIntent({
        attemptId: "attempt-01",
        fence: 1,
        action: "replace-current",
        phase: "SWITCH_INTENT",
        payload: {},
      });
      await rewriteRecord(
        temp.path,
        1,
        (record) => {
          record.checksum = "0".repeat(64);
        },
        false,
      );

      await expect(makeJournal(temp.path)).rejects.toBeInstanceOf(
        JournalCorruptError,
      );
    } finally {
      await temp.cleanup();
    }
  });

  it("rejects sequence rollback even when the checksum is self-consistent", async () => {
    const temp = await createTempRoot();
    try {
      const journal = await makeJournal(temp.path);
      await journal.beginAttempt(context());
      await journal.appendIntent({
        attemptId: "attempt-01",
        fence: 1,
        action: "replace-current",
        phase: "SWITCH_INTENT",
        payload: {},
      });
      await rewriteRecord(temp.path, 1, (record) => {
        record.seq = 1;
      });

      await expect(makeJournal(temp.path)).rejects.toThrow(
        /sequence/i,
      );
    } finally {
      await temp.cleanup();
    }
  });

  it("keeps the intent authoritative when append flush reports failure", async () => {
    const temp = await createTempRoot();
    try {
      const fs = new InjectableDurableFs();
      const journal = await makeJournal(temp.path, fs);
      await journal.beginAttempt(context());
      fs.failAfterWriteOperation = "append:update-attempt.journal";

      await expect(
        journal.appendIntent({
          attemptId: "attempt-01",
          fence: 1,
          action: "restore-database",
          phase: "ROLLBACK_INTENT",
          payload: { backupId: "backup-01" },
        }),
      ).rejects.toThrow(/flush failure/i);

      const reopened = await makeJournal(temp.path);
      const snapshot = await reopened.readSnapshot();
      expect(snapshot.phase).toBe("ROLLBACK_INTENT");
      expect(snapshot.pending?.action).toBe("restore-database");
    } finally {
      await temp.cleanup();
    }
  });

  it("rejects stale writers after the fencing token advances", async () => {
    const temp = await createTempRoot();
    try {
      const journal = await makeJournal(temp.path);
      await journal.beginAttempt(context({ fence: 2 }));
      await expect(
        journal.appendIntent({
          attemptId: "attempt-01",
          fence: 1,
          action: "replace-current",
          phase: "SWITCH_INTENT",
          payload: {},
        }),
      ).rejects.toBeInstanceOf(JournalFenceError);
    } finally {
      await temp.cleanup();
    }
  });

  it("does not append a second intent before the first is completed", async () => {
    const temp = await createTempRoot();
    try {
      const journal = await makeJournal(temp.path);
      await journal.beginAttempt(context());
      await journal.appendIntent({
        attemptId: "attempt-01",
        fence: 1,
        action: "replace-current",
        phase: "SWITCH_INTENT",
        payload: {},
      });

      await expect(
        journal.appendIntent({
          attemptId: "attempt-01",
          fence: 1,
          action: "migrate-database",
          phase: "MIGRATING",
          payload: {},
        }),
      ).rejects.toThrow(/pending intent/i);
    } finally {
      await temp.cleanup();
    }
  });

  it("opens a later attempt only after the prior attempt is terminal and advances the fence", async () => {
    const temp = await createTempRoot();
    try {
      const journal = await makeJournal(temp.path);
      await journal.beginAttempt(context());
      const intent = await journal.appendIntent({
        attemptId: "attempt-01",
        fence: 1,
        action: "promote-update",
        phase: "READY_TO_COMMIT",
        payload: { verified: true },
      });
      await journal.appendCompletion({
        attemptId: "attempt-01",
        fence: 1,
        intentId: intent.id,
        phase: "COMMITTED",
        result: { committed: true },
      });

      await journal.beginAttempt(
        context({
          attemptId: "attempt-02",
          fence: 2,
          currentVersion: "0.2.5",
          targetVersion: "0.3.0",
          previousVersion: "0.2.5",
        }),
      );
      expect(await journal.readSnapshot()).toMatchObject({
        attemptId: "attempt-02",
        fence: 2,
        phase: "PREPARED",
        pending: null,
      });
    } finally {
      await temp.cleanup();
    }
  });
});

it("does not truncate an active partial append when another instance opens or reads", async () => {
  const temp = await createTempRoot();
  try {
    const journal = await makeJournal(temp.path);
    await journal.beginAttempt(context());
    let resume!: () => void; let started!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const fs = new InjectableDurableFs();
    fs.append = async (filename, bytes) => {
      const split = Math.floor(bytes.length / 2);
      await appendFile(filename, bytes.subarray(0, split)); started(); await gate;
      await appendFile(filename, bytes.subarray(split));
    };
    const writer = await AttemptJournal.open(temp.path, { fs });
    const writing = writer.appendIntent({ attemptId: "attempt-01", fence: 1, action: "replace-current", phase: "SWITCH_INTENT" });
    await ready;
    try {
      const reader = await AttemptJournal.open(temp.path);
      expect((await reader.readSnapshot()).sequence).toBe(1);
      const script = `require(${JSON.stringify(path.resolve(__dirname, "attempt-journal.ts"))}).AttemptJournal.open(${JSON.stringify(temp.path)}).then(async journal => process.stdout.write(String((await journal.readSnapshot()).sequence))).catch(error => { console.error(error); process.exitCode = 1; });`;
      const result = await promisify(execFile)(process.execPath, ["-r", require.resolve("ts-node/register"), "-e", script], { windowsHide: true, env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "true", TS_NODE_PROJECT: path.resolve(__dirname, "../../tsconfig.json") } });
      expect(result.stdout).toBe("1");
    } finally { resume(); }
    await writing;
    expect((await journal.readSnapshot()).pending?.action).toBe("replace-current");
  } finally { await temp.cleanup(); }
});
