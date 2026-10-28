import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { AttemptJournal } from "../state/attempt-journal";
import {
  InjectedRollbackCrash,
  UpdateRollbackService,
} from "./rollback";

jest.setTimeout(30_000);

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "filestation-rollback-"));
  const databasePath = path.join(root, "data", "filestation.db");
  const snapshotPath = path.join(
    root,
    "backups",
    "backup-01",
    "update-snapshot.sqlite",
  );
  await mkdir(path.dirname(databasePath), { recursive: true });
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, "verified-snapshot");
  await writeFile(databasePath, "new-database");
  await writeFile(`${databasePath}-wal`, "new-wal");
  await writeFile(`${databasePath}-shm`, "new-shm");
  await writeFile(`${databasePath}-journal`, "new-journal");
  const journal = await AttemptJournal.open(root);
  await journal.beginAttempt({
    attemptId: "attempt-rollback-01",
    fence: 5,
    currentVersion: "0.2.0",
    targetVersion: "0.2.5",
    previousVersion: "0.2.0",
    backupId: "backup-01",
    phase: "PREPARED",
    owner: {
      bootIdentity: "linux:11111111-2222-3333-4444-555555555555",
      pid: 4321,
      processCreatedAt: "linux-starttime:1234",
      heartbeatAt: new Date().toISOString(),
    },
  });
  const snapshot = await journal.appendIntent({
    attemptId: "attempt-rollback-01",
    fence: 5,
    action: "snapshot-database",
    phase: "SNAPSHOT_READY",
    payload: {
      path: snapshotPath,
      sha256: createHash("sha256").update("verified-snapshot").digest("hex"),
    },
  });
  await journal.appendCompletion({
    attemptId: "attempt-rollback-01",
    fence: 5,
    intentId: snapshot.id,
    phase: "SNAPSHOT_READY",
  });
  const switched = await journal.appendIntent({
    attemptId: "attempt-rollback-01",
    fence: 5,
    action: "replace-current",
    phase: "SWITCH_INTENT",
    payload: { target: path.join(root, "releases/v0.2.5") },
  });
  await journal.appendCompletion({
    attemptId: "attempt-rollback-01",
    fence: 5,
    intentId: switched.id,
    phase: "CURRENT_SWITCHED",
  });
  return { root, databasePath, snapshotPath, journal };
}

describe("UpdateRollbackService", () => {
  it("moves database sidecars as one diagnostic set and preserves the snapshot", async () => {
    const value = await fixture();
    try {
      const result = await new UpdateRollbackService().restoreDatabase({
        root: value.root,
        journal: value.journal,
        attemptId: "attempt-rollback-01",
        fence: 5,
        databasePath: value.databasePath,
        snapshotPath: value.snapshotPath,
      });

      expect(await readFile(value.databasePath, "utf8")).toBe(
        "verified-snapshot",
      );
      expect(await readFile(value.snapshotPath, "utf8")).toBe(
        "verified-snapshot",
      );
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        await expect(
          readFile(`${value.databasePath}${suffix}`, "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      const diagnosticFiles = await readdir(result.diagnosticDirectory);
      expect(diagnosticFiles.sort()).toEqual(
        [
          "filestation.db",
          "filestation.db-journal",
          "filestation.db-shm",
          "filestation.db-wal",
          "manifest.json",
        ].sort(),
      );
      expect(await readFile(value.snapshotPath, "utf8")).not.toBe(
        "new-database",
      );
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it("resumes after a crash immediately after the diagnostic intent", async () => {
    const value = await fixture();
    try {
      await expect(
        new UpdateRollbackService({
          crashAt: "after-diagnostic-intent",
        }).restoreDatabase({
          root: value.root,
          journal: value.journal,
          attemptId: "attempt-rollback-01",
          fence: 5,
          databasePath: value.databasePath,
          snapshotPath: value.snapshotPath,
        }),
      ).rejects.toBeInstanceOf(InjectedRollbackCrash);

      const pending = await value.journal.readSnapshot();
      expect(pending.pending?.action).toBe("rollback-database");

      const result = await new UpdateRollbackService().restoreDatabase({
        root: value.root,
        journal: value.journal,
        attemptId: "attempt-rollback-01",
        fence: 5,
        databasePath: value.databasePath,
        snapshotPath: value.snapshotPath,
      });
      expect(await readFile(value.databasePath, "utf8")).toBe(
        "verified-snapshot",
      );
      expect((await value.journal.readSnapshot()).pending).toBeNull();
      expect(result.state).toBe("restored");
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it("refuses any snapshot restore after COMMITTED", async () => {
    const value = await fixture();
    try {
      const current = await value.journal.readSnapshot();
      const intent = await value.journal.appendIntent({
        attemptId: "attempt-rollback-01",
        fence: 5,
        action: "commit-update",
        phase: "READY_TO_COMMIT",
      });
      await value.journal.appendCompletion({
        attemptId: "attempt-rollback-01",
        fence: 5,
        intentId: intent.id,
        phase: "COMMITTED",
      });
      expect(current.phase).toBe("CURRENT_SWITCHED");

      await expect(
        new UpdateRollbackService().restoreDatabase({
          root: value.root,
          journal: value.journal,
          attemptId: "attempt-rollback-01",
          fence: 5,
          databasePath: value.databasePath,
          snapshotPath: value.snapshotPath,
        }),
      ).rejects.toThrow(/COMMITTED|rollback/i);
      expect(await readFile(value.databasePath, "utf8")).toBe("new-database");
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });
});
