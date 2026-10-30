import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AttemptJournal, NodeDurableFileSystem } from '@filestation/updater';
import { DataSource } from 'typeorm';
import { UpdateAuditReconciler } from './update-audit-reconciler';
import { WriteBarrierService } from '../maintenance/write-barrier.service';
import { WriteFreezeService } from '../maintenance/write-freeze.service';
import { registerMaintenanceRequestLease } from '../maintenance/maintenance-admission.guard';
import { DatabaseSnapshotService } from './database-snapshot.service';
import { HandoffUpdateInstallExecutor, UpdateInstallCoordinator } from './update-install-coordinator';
import { UpdateOperationReservationService } from './update-operation-reservation.service';
import { AuditService } from '../audit/audit.service';
import { UpdateCapabilityService } from './update-capability.service';
import { ApplicationShutdownService } from './application-shutdown.service';

async function journalFixture(
  root: string,
  terminal: boolean,
): Promise<AttemptJournal> {
  const journal = await AttemptJournal.open(root);
  await journal.beginAttempt({
    attemptId: 'attempt-audit-01',
    fence: 3,
    currentVersion: '0.2.0',
    targetVersion: '0.2.5',
    previousVersion: '0.2.0',
    backupId: 'backup-audit-01',
    phase: 'PREPARED',
    owner: {
      bootIdentity: 'fixture-boot',
      pid: 1234,
      processCreatedAt: 'fixture-created',
      heartbeatAt: new Date().toISOString(),
    },
  });
  const stop = await journal.appendIntent({
    attemptId: 'attempt-audit-01',
    fence: 3,
    action: 'record-old-stopped',
    phase: 'OLD_STOPPED',
  });
  await journal.appendCompletion({
    attemptId: 'attempt-audit-01',
    fence: 3,
    intentId: stop.id,
    phase: 'OLD_STOPPED',
  });
  if (terminal) {
    const commit = await journal.appendIntent({
      attemptId: 'attempt-audit-01',
      fence: 3,
      action: 'commit-update',
      phase: 'READY_TO_COMMIT',
    });
    await journal.appendCompletion({
      attemptId: 'attempt-audit-01',
      fence: 3,
      intentId: commit.id,
      phase: 'COMMITTED',
    });
  }
  return journal;
}

describe('UpdateAuditReconciler', () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'filestation-update-audit-')));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('counts paused replay through next-install drain and defers new maintenance replay', async () => {
    await journalFixture(root, true);
    const freeze = new WriteFreezeService();
    const barrier = new WriteBarrierService(freeze);
    const databasePath=path.join(root,'audit.sqlite');
    const db = new DataSource({type:'sqlite',database:databasePath});
    await db.initialize();
    await db.query('CREATE TABLE audit_logs (id TEXT PRIMARY KEY, account_id TEXT, action TEXT, resource_type TEXT, resource_id TEXT, details TEXT, ip_address TEXT, user_agent TEXT, created_at INTEGER, update_attempt_id TEXT, update_event TEXT, UNIQUE(update_attempt_id,update_event))');
    let resume!:()=>void; let inspected!:()=>void;
    const paused = new Promise<void>(r=>inspected=r);
    const gate = new Promise<void>(r=>resume=r);
    const query = db.query.bind(db);
    let writes = 0;
    jest.spyOn(db,'query').mockImplementation(async (sql,params) => {
      if (String(sql).startsWith('INSERT')) { if (writes++ === 0) { inspected(); await gate; } }
      return query(sql,params);
    });
    const reconciler = new UpdateAuditReconciler(db,barrier);
    const staging=path.join(root,'.filestation-update-staging','fixture','payload');await mkdir(staging,{recursive:true});
    const config={get:(key:string)=>key==='app.dbPath'?databasePath:key==='app.updateJournalRoot'?root:key==='app.storagePath'?path.join(root,'storage'):key==='app.tempPath'?path.join(root,'temp'):undefined} as ConfigService;
    const capability={inspect:async()=>({mode:'managed',supported:true,install_root:root,platform:process.platform==='win32'?'windows-x64':'linux-x64'})} as UpdateCapabilityService;
    const durable=new NodeDurableFileSystem();
    jest.spyOn(durable,'syncFile').mockRejectedValue(new Error('end fixture before freeze'));
    const snapshot=new DatabaseSnapshotService(db,config,barrier,freeze,durable);
    const capture=jest.spyOn(snapshot,'createVerifiedSnapshot');
    const executor=new HandoffUpdateInstallExecutor(config,capability,snapshot,barrier,{close:jest.fn()} as unknown as ApplicationShutdownService,{startWaiting:jest.fn()}, new UpdateSpacePreflightService(db, config, {resolveVolumeId:async()=> 'fixture-volume',readAvailableBytes:async()=>1024**4}));
    const coordinator=new UpdateInstallCoordinator(config,barrier,capability,{record:jest.fn()} as unknown as AuditService,executor,{current:async()=>({provider:'windows-cim',value:'fixture'}),processCreatedAt:async()=> 'fixture-created',isProcessAlive:async()=>true},Date.now,'0.2.5',randomUUID,new UpdateOperationReservationService());
    const replay = reconciler.reconcile(root);
    try {
      await paused;
      expect(barrier.activeLeaseCount).toBe(1);
      const next=await coordinator.accept(Object.freeze({space_budget:Object.freeze({database_migration:false,migration_workspace_multiplier:0,migration_workspace_min_bytes:0}),prepared_id:randomUUID(),manifest_sha256:'a'.repeat(64),artifact_sha256:'b'.repeat(64),version:'0.2.6',platform:process.platform==='win32'?'windows-x64':'linux-x64',arch:'x64',staging_path:await realpath(staging),verified_size:1,unpacked_size:1,expires_at:Date.now()+60000}));
      const response=new EventEmitter() as Response;
      const http=await barrier.acquire('http');
      const state=registerMaintenanceRequestLease({} as any,response,http);state.handlerStarted=true;state.handlerDone=true;
      coordinator.scheduleAfterResponse(next.attempt,response);response.emit('finish');
      for(let i=0;i<200 && barrier.accepting;i++) await new Promise(r=>setTimeout(r,10));
      expect(barrier.accepting).toBe(false);
      await expect(reconciler.reconcile(root)).resolves.toEqual({inserted:0,skipped:0});
      expect(capture).not.toHaveBeenCalled();
      expect(writes).toBe(1);
      resume(); await replay;
      for(let i=0;i<400 && (!barrier.accepting || (coordinator as any).changing);i++) await new Promise(r=>setTimeout(r,10));
      expect(capture).toHaveBeenCalledTimes(1);expect(barrier.accepting).toBe(true);
      const count=writes;
      await reconciler.reconcile(root);
      expect(writes).toBeGreaterThanOrEqual(count);
      expect(await query("SELECT count(*) AS n FROM audit_logs WHERE update_attempt_id='attempt-audit-01'")).toEqual([{n:2}]);
    } finally {resume(); await replay; reconciler.onModuleDestroy(); await coordinator.onModuleDestroy();await (coordinator as any).ownership?.recoveryGuard.release();await db.destroy();}
  },15000);

  it('replays validated older terminal events exactly once after newer PREPARED', async () => {
    const journal=await journalFixture(root,true);
    const restart=await journal.appendIntent({attemptId:'attempt-audit-01',fence:3,action:'verify-committed-restart',phase:'COMMITTED'});
    await journal.appendCompletion({attemptId:'attempt-audit-01',fence:3,intentId:restart.id,phase:'COMMITTED',result:{version:'0.2.5',health:'ok'}});
    const prior=await journal.readSnapshot();
    await journal.beginAttempt({...prior.records.at(-1)!.context,attemptId:'attempt-new',fence:4,phase:'PREPARED'});
    const barrier=new WriteBarrierService(new WriteFreezeService());
    const db=new DataSource({type:'sqlite',database:':memory:'}); await db.initialize();
    await db.query('CREATE TABLE audit_logs (id TEXT PRIMARY KEY, account_id TEXT, action TEXT, resource_type TEXT, resource_id TEXT, details TEXT, ip_address TEXT, user_agent TEXT, created_at INTEGER, update_attempt_id TEXT, update_event TEXT, UNIQUE(update_attempt_id,update_event))');
    const reconciler=new UpdateAuditReconciler(db,barrier);
    const query=db.query.bind(db);let insertCount=0;
    jest.spyOn(db,'query').mockImplementation(async (sql,params)=>{
      if(String(sql).startsWith('INSERT') && ++insertCount===2) throw new Error('interrupted replay');
      return query(sql,params);
    });
    try {
      await reconciler.reconcile(root);
      // The deferred retry must replay history even though current is PREPARED.
      for(let i=0;i<150 && (await query('SELECT count(*) AS n FROM audit_logs'))[0].n!==3;i++) await new Promise(r=>setTimeout(r,10));
      await reconciler.reconcile(root);
      expect(await db.query('SELECT update_attempt_id,update_event FROM audit_logs ORDER BY update_event')).toEqual([
        {update_attempt_id:'attempt-audit-01',update_event:'COMMITTED'},
        {update_attempt_id:'attempt-audit-01',update_event:'OLD_STOPPED'},
        {update_attempt_id:'attempt-audit-01',update_event:'RESTART_VERIFIED'},
      ]);
    } finally {reconciler.onModuleDestroy(); await db.destroy();}
  });

  it('does not write audit rows during maintenance', async () => {
    await journalFixture(root, false);
    const query = jest.fn();
    const reconciler = new UpdateAuditReconciler(
      { query } as unknown as DataSource,
      new WriteBarrierService(new WriteFreezeService()),
    );

    await expect(reconciler.reconcile(root)).resolves.toEqual({
      inserted: 0,
      skipped: 0,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('uses deterministic insert-or-ignore events after a terminal journal', async () => {
    await journalFixture(root, true);
    const query = jest
      .fn()
      .mockResolvedValueOnce({ changes: 1 })
      .mockResolvedValueOnce({ changes: 1 })
      .mockResolvedValueOnce({ changes: 0 })
      .mockResolvedValueOnce({ changes: 0 });
    const reconciler = new UpdateAuditReconciler(
      { query } as unknown as DataSource,
      new WriteBarrierService(new WriteFreezeService()),
    );

    const first = await reconciler.reconcile(root);
    const retry = await reconciler.reconcile(root);

    expect(first).toEqual({ inserted: 2, skipped: 0 });
    expect(retry).toEqual({ inserted: 0, skipped: 2 });
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[0][0]).toMatch(/INSERT OR IGNORE/i);
    expect(query.mock.calls[0][1][0]).toBe(query.mock.calls[2][1][0]);
    expect(JSON.stringify(query.mock.calls)).not.toContain('capability');
  });
});
import { UpdateSpacePreflightService } from './update-space-preflight.service';
