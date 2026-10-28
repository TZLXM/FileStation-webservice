import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AttemptJournal } from "../state/attempt-journal";
import { RetentionService } from "./retention";
import { createHash } from 'node:crypto';

async function committedFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "filestation-retention-"));
  const releases = path.join(root, "releases");
  const currentRelease = path.join(releases, "v0.2.5-current");
  const previousRelease = path.join(releases, "v0.2.0-previous");
  const unusedRelease = path.join(releases, "v0.1.9-unused");
  for (const release of [currentRelease, previousRelease, unusedRelease]) {
    await mkdir(release, { recursive: true });
    await writeFile(path.join(release, "package.json"), "{}");
  }
  await mkdir(path.join(root, "backups", "bootstrap-fixture"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, "backups", "bootstrap-fixture", "update-snapshot.sqlite"),
    "snapshot",
  );
  const current = path.join(root, "current");
  await new (await import("../platform/durable-fs")).NodeDurableFileSystem()
    .createJunction(currentRelease, current)
    .catch(async () => {
      const { symlink } = await import("node:fs/promises");
      await symlink(
        currentRelease,
        current,
        process.platform === "win32" ? "junction" : "dir",
      );
    });
  const journal = await AttemptJournal.open(root);
  await journal.beginAttempt({
    attemptId: "attempt-retention-01",
    fence: 7,
    currentVersion: "0.2.0",
    targetVersion: "0.2.5",
    previousVersion: "0.2.0",
    backupId: "backup-retention-01",
    phase: "PREPARED",
    owner: {
      bootIdentity: "fixture-boot",
      pid: 1234,
      processCreatedAt: "fixture-created",
      heartbeatAt: new Date().toISOString(),
    },
  });
  const switched = await journal.appendIntent({
    attemptId: "attempt-retention-01",
    fence: 7,
    action: "replace-current",
    phase: "SWITCH_INTENT",
    payload: {
      target: currentRelease,
      originalTarget: previousRelease,
    },
  });
  await journal.appendCompletion({
    attemptId: "attempt-retention-01",
    fence: 7,
    intentId: switched.id,
    phase: "CURRENT_SWITCHED",
  });
  const commit = await journal.appendIntent({
    attemptId: "attempt-retention-01",
    fence: 7,
    action: "commit-update",
    phase: "READY_TO_COMMIT",
  });
  await journal.appendCompletion({
    attemptId: "attempt-retention-01",
    fence: 7,
    intentId: commit.id,
    phase: "COMMITTED",
  });
  return { root, journal, currentRelease, previousRelease, unusedRelease };
}

describe("RetentionService", () => {
  it.each(['backups', 'selected'])(`refuses native linked %s ancestry without touching outside assets`, async level => {
    const root = await mkdtemp(path.join(tmpdir(), 'retention-link-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'retention-sentinel-'));
    try {
      const backup = level === 'backups' ? path.join(outside, 'exact') : outside;
      await mkdir(path.join(backup, 'env'), {recursive:true});
      await writeFile(path.join(backup, 'env', 'sentinel'), 'preserve');
      await mkdir(path.join(root, 'backups'), {recursive:true});
      const link = level === 'backups' ? path.join(root, 'backups') : path.join(root, 'backups', 'exact');
      if(level === 'backups') await rm(link, {recursive:true});
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(new RetentionService(root).cleanupBootstrapRecoveryAssets('exact')).rejects.toThrow(/canonical|link|directory/);
      expect(await readFile(path.join(backup, 'env', 'sentinel'), 'utf8')).toBe('preserve');
    } finally {await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
  });
  it('retains and exact-ID acknowledges journal-bound DB-volume diagnostics through backup references',async()=>{
    const v=await committedFixture();
    const directories:string[]=[];
    try {
      const {context}=await import('../test-support');
      for(let i=0;i<4;i++) {
        const attemptId='failed-local-'+i, fence=8+i;
        const token=createHash('sha256').update(`${attemptId}:${fence}`).digest('hex').slice(0,24);
        const databasePath=path.join(v.root,'db-volume','live.db');
        const diagnosticDirectory=path.join(path.dirname(databasePath),'.filestation-update-diagnostics',token);
        directories.push(diagnosticDirectory);
        const snapshotPath=path.join(v.root,'backups','backup-'+i,'snapshot.sqlite');
        const reference=path.join(path.dirname(snapshotPath),'diagnostics',`${attemptId}-${fence}`,'manifest.json');
        await mkdir(diagnosticDirectory,{recursive:true});await mkdir(path.dirname(reference),{recursive:true});
        await writeFile(snapshotPath,'unique-snapshot');
        const manifest={attemptId,fence,databasePath,snapshotPath,diagnosticDirectory,restoreTag:token,createdAt:new Date(2026,0,i+1).toISOString(),detached:true};
        await writeFile(path.join(diagnosticDirectory,'manifest.json'),JSON.stringify(manifest));await writeFile(path.join(diagnosticDirectory,'live.db'),'failed-db');
        await writeFile(reference,JSON.stringify(manifest));
        await v.journal.beginAttempt(context({attemptId,fence,phase:'ROLLBACK_INTENT'}));
        const intent=await v.journal.appendIntent({attemptId,fence,action:'rollback-database',phase:'ROLLBACK_INTENT',payload:{databasePath,snapshotPath,diagnosticDirectory,restoreTag:token}});
        await v.journal.appendCompletion({attemptId,fence,intentId:intent.id,phase:'ROLLED_BACK'});
      }
      await v.journal.beginAttempt(context({attemptId:'final-retention',fence:12,phase:'COMMITTED',targetVersion:'0.2.5'}));
      const proof=await v.journal.appendIntent({attemptId:'final-retention',fence:12,action:'verify-committed-restart',phase:'COMMITTED'});
      await v.journal.appendCompletion({attemptId:'final-retention',fence:12,intentId:proof.id,phase:'COMMITTED',result:{version:'0.2.5',health:'ok',pid:1234,createdAt:'fixture-created',boot:'fixture-boot',nonce:'fixture-nonce-0123456789',release:v.currentRelease}});
      const service=new RetentionService(v.root);
      await service.cleanup(await v.journal.readSnapshot());
      await expect(readFile(path.join(directories[0],'live.db'))).rejects.toMatchObject({code:'ENOENT'});
      for(const dir of directories.slice(1)) expect(await readFile(path.join(dir,'live.db'),'utf8')).toBe('failed-db');
      await service.acknowledgeDiagnostic('failed-local-3-11');
      await service.cleanup(await v.journal.readSnapshot());
      await expect(readFile(path.join(directories[3],'live.db'))).rejects.toMatchObject({code:'ENOENT'});
      expect(await readFile(path.join(v.root,'backups','backup-0','snapshot.sqlite'),'utf8')).toBe('unique-snapshot');
    } finally {await rm(v.root,{recursive:true,force:true});}
  },30000);
  it('preserves a release referenced only by a previous attempt in the durable journal',async()=>{
    const v=await committedFixture();
    try {
      const ref=await v.journal.appendIntent({attemptId:'attempt-retention-01',fence:7,action:'snapshot-reference',phase:'COMMITTED',payload:{releasePath:v.unusedRelease}});
      await v.journal.appendCompletion({attemptId:'attempt-retention-01',fence:7,intentId:ref.id,phase:'COMMITTED'});
      const {context}=await import('../test-support');
      await v.journal.beginAttempt(context({attemptId:'attempt-retention-02',fence:8,phase:'COMMITTED',currentVersion:'0.2.5',targetVersion:'0.2.5'}));
      const proof=await v.journal.appendIntent({attemptId:'attempt-retention-02',fence:8,action:'verify-committed-restart',phase:'COMMITTED'});
      await v.journal.appendCompletion({attemptId:'attempt-retention-02',fence:8,intentId:proof.id,phase:'COMMITTED',result:{version:'0.2.5',health:'ok',pid:1234,createdAt:'fixture-created',boot:'fixture-boot',nonce:'fixture-nonce-0123456789',release:v.currentRelease}});
      expect((await new RetentionService(v.root).cleanup(await v.journal.readSnapshot())).deleted).not.toContain(v.unusedRelease);
    }finally{await rm(v.root,{recursive:true,force:true});}
  });
  it('rejects a legacy generic-200 record without independent process proof',async()=>{
    const v=await committedFixture();
    try {
      const intent=await v.journal.appendIntent({attemptId:'attempt-retention-01',fence:7,action:'verify-committed-restart',phase:'COMMITTED'});
      await v.journal.appendCompletion({attemptId:'attempt-retention-01',fence:7,intentId:intent.id,phase:'COMMITTED',result:{version:'0.2.5',health:'ok'}});
      expect((await new RetentionService(v.root).cleanup(await v.journal.readSnapshot())).eligible).toBe(false);
    }finally{await rm(v.root,{recursive:true,force:true});}
  });
  it('retains releases referenced only by backup metadata and bounds other diagnostics',async()=>{
    const v=await committedFixture();
    try {
      const verify=await v.journal.appendIntent({attemptId:'attempt-retention-01',fence:7,action:'verify-committed-restart',phase:'COMMITTED'});
      await v.journal.appendCompletion({attemptId:'attempt-retention-01',fence:7,intentId:verify.id,phase:'COMMITTED',result:{version:'0.2.5',health:'ok',pid:1234,createdAt:'fixture-created',boot:'fixture-boot',nonce:'fixture-nonce-0123456789',release:v.currentRelease}});
      await writeFile(path.join(v.root,'backups','bootstrap-fixture','manifest.json'),JSON.stringify({releasePath:v.unusedRelease}));
      for(let i=0;i<5;i++) {
        const dir=path.join(v.root,'backups','bootstrap-fixture','diagnostics','failed-'+i);
        await mkdir(dir,{recursive:true}); await writeFile(path.join(dir,'manifest.json'),JSON.stringify({attemptId:'failed-'+i,createdAt:new Date(2026,0,i+1).toISOString()}));
      }
      const result=await new RetentionService(v.root).cleanup(await v.journal.readSnapshot());
      expect(result.deleted).not.toContain(v.unusedRelease);
      const {readdir}=await import('node:fs/promises');
      expect(await readdir(path.join(v.root,'backups','bootstrap-fixture','diagnostics'))).toEqual(['failed-2','failed-3','failed-4']);
      await expect(new RetentionService(v.root).acknowledgeDiagnostic('../failed-4')).rejects.toThrow(/exact/);
      await new RetentionService(v.root).acknowledgeDiagnostic('failed-4');
      await new RetentionService(v.root).cleanup(await v.journal.readSnapshot());
      expect(await readdir(path.join(v.root,'backups','bootstrap-fixture','diagnostics'))).toEqual(['failed-2','failed-3']);
      expect(await readFile(path.join(v.root,'backups','bootstrap-fixture','update-snapshot.sqlite'),'utf8')).toBe('snapshot');
    } finally {await rm(v.root,{recursive:true,force:true});}
  });
  it("does not delete assets before durable post-commit restart verification", async () => {
    const value = await committedFixture();
    try {
      const service = new RetentionService(value.root);
      const result = await service.cleanup(
        await value.journal.readSnapshot(),
      );
      expect(result.eligible).toBe(false);
      expect(result.deleted).toEqual([]);
      await expect(
        readFile(path.join(value.unusedRelease, "package.json")),
      ).resolves.toEqual(Buffer.from("{}"));
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it("cleans only unreferenced releases after restart verification", async () => {
    const value = await committedFixture();
    try {
      const verify = await value.journal.appendIntent({
        attemptId: "attempt-retention-01",
        fence: 7,
        action: "verify-committed-restart",
        phase: "COMMITTED",
        payload: { version: "0.2.5" },
      });
      await value.journal.appendCompletion({
        attemptId: "attempt-retention-01",
        fence: 7,
        intentId: verify.id,
        phase: "COMMITTED",
        result: { version: "0.2.5", health: "ok", pid:1234,createdAt:'fixture-created',boot:'fixture-boot',nonce:'fixture-nonce-0123456789',release:value.currentRelease },
      });
      const service = new RetentionService(value.root);
      const result = await service.cleanup(
        await value.journal.readSnapshot(),
      );
      expect(result.eligible).toBe(true);
      expect(result.deleted).toContain(value.unusedRelease);
      await expect(
        readFile(path.join(value.currentRelease, "package.json")),
      ).resolves.toEqual(Buffer.from("{}"));
      await expect(
        readFile(path.join(value.previousRelease, "package.json")),
      ).resolves.toEqual(Buffer.from("{}"));
      await expect(
        readFile(path.join(value.unusedRelease, "package.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it("removes bootstrap env/source assets only for one exact backup id", async () => {
    const value = await committedFixture();
    try {
      const bootstrap = path.join(
        value.root,
        "backups",
        "bootstrap-fixture",
      );
      const env = path.join(bootstrap, "env");
      const legacy = path.join(bootstrap, "legacy-source");
      await mkdir(env, { recursive: true });
      await mkdir(legacy, { recursive: true });
      await writeFile(path.join(env, "legacy.env"), "JWT_SECRET=fixture");
      await writeFile(path.join(legacy, "package.json"), "{}");
      await writeFile(path.join(bootstrap, 'MANIFEST.json'), JSON.stringify({schemaVersion:1,kind:'bootstrap-backup',backupId:'bootstrap-fixture',installRoot:value.root,installId:'retention-fixture'}));
      await writeFile(path.join(value.root, 'managed-install.json'), JSON.stringify({installId:'retention-fixture',bootstrapBackupId:'bootstrap-fixture'}));
      const service = new RetentionService(value.root);

      await expect(
        service.cleanupBootstrapRecoveryAssets("../backups"),
      ).rejects.toThrow(/identifier|exact|id/i);
      const removed = await service.cleanupBootstrapRecoveryAssets(
        "bootstrap-fixture",
      );
      expect(removed).toEqual(
        expect.arrayContaining([env, legacy]),
      );
      await expect(
        readFile(
          path.join(bootstrap, "update-snapshot.sqlite"),
          "utf8",
        ),
      ).resolves.toBe("snapshot");
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });
});
