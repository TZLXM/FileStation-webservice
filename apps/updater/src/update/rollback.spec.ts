import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { AttemptJournal } from "../state/attempt-journal";
import { NodeDurableFileSystem } from "../platform/durable-fs";
import {
  InjectedRollbackCrash,
  UpdateRollbackService,
} from "./rollback";

jest.setTimeout(30_000);

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "filestation-rollback-")));
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
  it('refuses a retargeted diagnostic ancestor before mkdir/protect/detach', async()=>{
    const v=await fixture();
    const outside=await realpath(await mkdtemp(path.join(tmpdir(), 'rollback-diagnostic-outside-')));
    try {
      const {symlink}=await import('node:fs/promises');
      await symlink(outside,path.join(path.dirname(v.databasePath),'.filestation-update-diagnostics'),process.platform==='win32'?'junction':'dir');
      await expect(new UpdateRollbackService().restoreDatabase({...v,attemptId:'attempt-rollback-01',fence:5})).rejects.toThrow(/canonical|drift|link/i);
      expect(await readdir(outside)).toEqual([]);
      expect(await readFile(v.databasePath,'utf8')).toBe('new-database');
    } finally {await rm(v.root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
  });
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

describe('rollback filesystem crash boundaries', () => {
  it.each(['after-diagnostic-intent', 'after-move-db', 'after-move-wal', 'after-move-shm', 'after-move-journal', 'before-publication', 'after-publication'])('split-volume rollback resumes %s with journal-bound DB-volume diagnostics', async (point) => {
    const v = await fixture();
    const fs = new NodeDurableFileSystem();
    const rename = fs.rename.bind(fs);
    jest.spyOn(fs, 'rename').mockImplementation(async (source, target, options) => {
      // Model the accepted layout: data and backups are different volumes.
      const volume = (p: string) => p.startsWith(path.join(v.root, 'data')) ? 'db' : 'install';
      if (volume(source) !== volume(target)) throw Object.assign(new Error('cross-volume rename'), {code: 'EXDEV'});
      return rename(source, target, options);
    });
    const input = {...v, attemptId: 'attempt-rollback-01', fence: 5};
    try {
      await expect(new UpdateRollbackService({fs, crashAt: point as never}).restoreDatabase(input)).rejects.toBeInstanceOf(InjectedRollbackCrash);
      const pending=await v.journal.readSnapshot();
      const replace=await v.journal.appendIntent({attemptId:input.attemptId,fence:5,action:'replace-owner',phase:pending.phase!});
      await v.journal.appendCompletion({attemptId:input.attemptId,fence:5,intentId:replace.id,phase:pending.phase!,nextContext:{...pending.records.at(-1)!.context,fence:6}});
      input.fence=6;
      const result = await new UpdateRollbackService({fs}).restoreDatabase(input);
      expect(result.diagnosticDirectory.startsWith(path.dirname(v.databasePath) + path.sep)).toBe(true);
      expect(await readFile(v.databasePath, 'utf8')).toBe('verified-snapshot');
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        expect(await readFile(path.join(result.diagnosticDirectory, 'filestation.db' + suffix), 'utf8')).toBe(suffix ? 'new' + suffix : 'new-database');
      }
      const reference = JSON.parse(await readFile(path.join(path.dirname(v.snapshotPath), 'diagnostics', 'attempt-rollback-01-5', 'manifest.json'), 'utf8'));
      expect(reference.diagnosticDirectory).toBe(result.diagnosticDirectory);
      expect((await v.journal.readSnapshot()).pending).toBeNull();
    } finally { await rm(v.root, {recursive: true, force: true}); }
  });
  it.each(['after-move-db', 'after-move-wal', 'after-move-shm', 'after-move-journal', 'before-publication', 'after-publication'])('resumes %s without losing diagnostics or mixing sidecars', async (point) => {
    const v=await fixture();
    const input={...v, attemptId:'attempt-rollback-01', fence:5};
    try {
      await expect(new UpdateRollbackService({crashAt:point as never}).restoreDatabase(input)).rejects.toBeInstanceOf(InjectedRollbackCrash);
      await new UpdateRollbackService().restoreDatabase(input);
      expect(await readFile(v.databasePath,'utf8')).toBe('verified-snapshot');
      const reference=JSON.parse(await readFile(path.join(path.dirname(v.snapshotPath),'diagnostics','attempt-rollback-01-5','manifest.json'),'utf8'));
      const diagnostics=reference.diagnosticDirectory;
      expect(await readFile(path.join(diagnostics,'filestation.db'),'utf8')).toBe('new-database');
      for(const suffix of ['-wal','-shm','-journal']) {
        expect(await readFile(path.join(diagnostics,'filestation.db'+suffix),'utf8')).toBe('new'+suffix);
        await expect(readFile(v.databasePath+suffix)).rejects.toMatchObject({code:'ENOENT'});
      }
      expect((await v.journal.readSnapshot()).pending).toBeNull();
    } finally {await rm(v.root,{recursive:true,force:true});}
  });
});
