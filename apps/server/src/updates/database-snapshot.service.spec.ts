import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NodeDurableFileSystem } from '@filestation/updater';
import { DataSource } from 'typeorm';
import sqlite3 = require('sqlite3');
import { SystemMeta } from '../auth/entities/system-meta.entity';
import { SqliteImmediateTransactionService } from '../common/database/sqlite-immediate-transaction.service';
import { StorageService } from '../files/storage.service';
import { WriteBarrierService } from '../maintenance/write-barrier.service';
import { WriteFreezeService } from '../maintenance/write-freeze.service';
import { DatabaseSnapshotService } from './database-snapshot.service';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AttemptJournal } from '@filestation/updater';
import { AuditService } from '../audit/audit.service';
import { registerMaintenanceRequestLease } from '../maintenance/maintenance-admission.guard';
import { HandoffUpdateInstallExecutor, UpdateInstallCoordinator } from './update-install-coordinator';
import { UpdateOperationReservationService } from './update-operation-reservation.service';
import { UpdateCapabilityService } from './update-capability.service';
import { ApplicationShutdownService } from './application-shutdown.service';

function openReadonly(filename: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(
      filename,
      sqlite3.OPEN_READONLY | sqlite3.OPEN_FULLMUTEX,
      (error) => (error ? reject(error) : resolve(database)),
    );
  });
}

function all<T>(database: sqlite3.Database, sql: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    database.all(sql, (error, rows) =>
      error ? reject(error) : resolve(rows as T[]),
    );
  });
}

function close(database: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    database.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('DatabaseSnapshotService', () => {
  let root: string;
  let databasePath: string;
  let dataSource: DataSource;
  let freeze: WriteFreezeService;
  let barrier: WriteBarrierService;
  let service: DatabaseSnapshotService;

  const attempt = () => ({
    attemptId: 'attempt-01',
    fence: 9,
    installRoot: root,
    backupId: 'backup-01',
    targetVersion: '0.2.5',
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'filestation-task7-snapshot-'));
    databasePath = path.join(root, 'data', 'source.db');
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(path.dirname(databasePath), { recursive: true }),
    );
    dataSource = new DataSource({
      type: 'sqlite',
      database: databasePath,
      entities: [SystemMeta],
      synchronize: true,
    });
    await dataSource.initialize();
    await dataSource.query('PRAGMA journal_mode = WAL');
    await dataSource.query('PRAGMA wal_autocheckpoint = 0');
    await dataSource.query('PRAGMA foreign_keys = ON');
    await dataSource.query(
      `INSERT INTO system_meta (key, value) VALUES ('wal-only', 'committed')`,
    );

    freeze = new WriteFreezeService();
    barrier = new WriteBarrierService(freeze);
    service = new DatabaseSnapshotService(
      dataSource,
      {
        get: (key: string) =>
          key === 'app.dbPath'
            ? databasePath
            : undefined,
      } as any,
      barrier,
      freeze,
    );
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await rm(root, { recursive: true, force: true });
  });

  it.each(['file', 'parent', 'drain', 'freeze', 'close'])('scheduled real handoff handles %s failure with retry only before freeze', async (failure) => {
    const staging = path.join(root, '.filestation-update-staging', 'one', 'payload');
    await import('node:fs/promises').then(fs => fs.mkdir(staging, {recursive:true}));
    const durable = new NodeDurableFileSystem();
    let fileSynced = false;
    const sync = durable.syncFile.bind(durable);
    jest.spyOn(durable, 'syncFile').mockImplementation(async filename => {
      if (failure === 'file') throw new Error('snapshot file flush');
      await sync(filename); fileSynced = true;
    });
    const syncParent = durable.fsyncDirectory.bind(durable);
    jest.spyOn(durable, 'fsyncDirectory').mockImplementation(async directory => {
      if (failure === 'parent' && fileSynced) throw new Error('snapshot parent flush');
      await syncParent(directory);
    });
    if (failure === 'drain') jest.spyOn(barrier, 'waitForZero').mockRejectedValueOnce(new Error('drain deadline'));
    const config = {get:(key:string) => key === 'app.dbPath' ? databasePath : key === 'app.updateJournalRoot' ? root :key==='app.storagePath'?path.join(root,'storage'):key==='app.tempPath'?path.join(root,'temp'):undefined} as ConfigService;
    const capability = {inspect:async()=>({mode:'managed', supported:true, install_root:root, platform: process.platform === 'win32' ? 'windows-x64' : 'linux-x64'})} as UpdateCapabilityService;
    const snapshot = new DatabaseSnapshotService(dataSource, config, barrier, freeze, durable);
    const frozen = jest.spyOn(snapshot, 'freezeSourceDatabase');
    if (failure === 'freeze') {
      const freezeSource = DatabaseSnapshotService.prototype.freezeSourceDatabase.bind(snapshot);
      frozen.mockImplementation(async attempt => { await freezeSource(attempt); throw new Error('partially frozen'); });
    }
    const close = jest.fn(async()=>{throw new Error('partial close');}); const spawn = jest.fn();
    const executor = new HandoffUpdateInstallExecutor(config, capability, snapshot, barrier, {close} as unknown as ApplicationShutdownService, {startWaiting:spawn}, new UpdateSpacePreflightService(dataSource, config, {resolveVolumeId:async()=> 'fixture-volume',readAvailableBytes:async()=>1024**4}));
    const execute=executor.execute.bind(executor);let executed=false;
    jest.spyOn(executor,'execute').mockImplementation(async context=>{try{await execute(context);}finally{executed=true;}});
    const identity = {current:async()=>({provider:'windows-cim' as const,value:'fixture-boot'}),processCreatedAt:async()=> 'fixture-created',isProcessAlive:async()=>true};
    const coordinator = new UpdateInstallCoordinator(config, barrier, capability, {record:jest.fn()} as unknown as AuditService, executor, identity, Date.now, '0.2.0', randomUUID, new UpdateOperationReservationService());
    const receipt = Object.freeze({space_budget:Object.freeze({database_migration:false,migration_workspace_multiplier:0,migration_workspace_min_bytes:0}),prepared_id:randomUUID(),manifest_sha256:'a'.repeat(64),artifact_sha256:'b'.repeat(64),version:'0.2.5', platform:process.platform === 'win32' ? 'windows-x64' : 'linux-x64',arch:'x64',staging_path:await import('node:fs/promises').then(fs=>fs.realpath(staging)),verified_size:1,unpacked_size:1,expires_at:Date.now()+60000});
    try {
      const accepted = await coordinator.accept(receipt);
      const response = new EventEmitter() as Response;
      const lease = await barrier.acquire('http');
      const state = registerMaintenanceRequestLease({} as any,response,lease);
      state.handlerStarted=true; state.handlerDone=true;
      coordinator.scheduleAfterResponse(accepted.attempt,response);
      response.emit('finish');
      // Bound the real scheduled asynchronous execution without weakening assertions.
      for(let i=0;i<400 && (!executed || (coordinator as any).changing);i++) await new Promise(r=>setTimeout(r,10));
      expect(executed).toBe(true);
      if (failure === 'freeze' || failure === 'close') {
        expect(barrier.accepting).toBe(false);expect(freeze.isFrozen).toBe(true);
        await expect(barrier.acquire('cron:file-lifecycle')).rejects.toThrow();
        await expect(coordinator.accept(Object.freeze({...receipt,prepared_id:randomUUID()}))).rejects.toThrow();
        expect(spawn).toHaveBeenCalledTimes(failure === 'close' ? 1 : 0);
        expect(close).toHaveBeenCalledTimes(failure === 'close' ? 1 : 0);
        expect((await AttemptJournal.inspect(root)).records.some(r=>r.phase==='HANDOFF_READY')).toBe(false);
        return;
      }
      expect((await AttemptJournal.inspect(root)).phase).toBe('FAILED');
      for(let i=0;i<100 && !barrier.accepting;i++) await new Promise(r=>setTimeout(r,10));
      expect(barrier.accepting).toBe(true);
      expect(frozen).not.toHaveBeenCalled(); expect(freeze.isFrozen).toBe(false);
      expect(close).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
      await barrier.withLease('cron:file-lifecycle',async()=> { await dataSource.query("INSERT INTO system_meta (key,value) VALUES ('resumed','yes')"); });
      const retry = await coordinator.accept(Object.freeze({...receipt,prepared_id:randomUUID()}));
      expect(retry.attempt_id).not.toBe(accepted.attempt_id);
      expect((await AttemptJournal.inspect(root)).phase).toBe('PREPARED');
    } finally {
      await coordinator.onModuleDestroy();
      // These fixtures model a failed post-freeze handoff without exiting this
      // test process. Production intentionally retains both guards until exit.
      await (coordinator as any).ownership?.recoveryGuard.release();
      await (coordinator as any).operationReservation?.release();
      jest.restoreAllMocks();
    }
  },15000);

  it('closes the verifier, syncs the snapshot and parent before returning a receipt', async () => {
    const durable = new NodeDurableFileSystem();
    const events: string[] = [];
    const originalClose = sqlite3.Database.prototype.close;
    const closeSpy = jest.spyOn(sqlite3.Database.prototype, 'close').mockImplementation(function (this: sqlite3.Database, callback?: (error: Error | null) => void) {
      return originalClose.call(this, (error: Error | null) => {
        events.push('verifier-closed');
        callback?.(error);
      });
    });
    const originalSync = durable.syncFile.bind(durable);
    jest.spyOn(durable, 'syncFile').mockImplementation(async (filename) => {
      expect(events).toEqual(['verifier-closed']);
      await originalSync(filename);
      events.push('file-synced');
    });
    const originalDirectorySync = durable.fsyncDirectory.bind(durable);
    jest.spyOn(durable, 'fsyncDirectory').mockImplementation(async (directory) => {
      await originalDirectorySync(directory);
      if (events.includes('file-synced')) {
        expect(directory).toBe(path.join(root, 'backups', attempt().backupId));
        events.push('parent-synced');
      }
    });
    const snapshot = new DatabaseSnapshotService(dataSource,
      { get: () => databasePath } as any, barrier, freeze, durable);
    barrier.enterMaintenance(attempt());
    try {
      await snapshot.createVerifiedSnapshot(attempt());
      events.push('receipt');
      expect(events).toEqual(['verifier-closed', 'file-synced', 'parent-synced', 'receipt']);
    } finally {
      closeSpy.mockRestore();
    }
  });

  it.each(['file', 'parent'])('does not return a receipt when %s flush fails', async (failure) => {
    const durable = new NodeDurableFileSystem();
    let fileSynced = false;
    const sync = durable.syncFile.bind(durable);
    jest.spyOn(durable, 'syncFile').mockImplementation(async (filename) => {
      if (failure === 'file') throw new Error('injected snapshot flush failure');
      await sync(filename);
      fileSynced = true;
    });
    const syncDirectory = durable.fsyncDirectory.bind(durable);
    jest.spyOn(durable, 'fsyncDirectory').mockImplementation(async (directory) => {
      if (fileSynced) throw new Error('injected snapshot flush failure');
      await syncDirectory(directory);
    });
    const snapshot = new DatabaseSnapshotService(dataSource,
      { get: () => databasePath } as any, barrier, freeze, durable);
    barrier.enterMaintenance(attempt());
    await expect(snapshot.createVerifiedSnapshot(attempt())).rejects.toThrow('injected snapshot flush failure');
    await expect(stat(path.join(root, 'backups', attempt().backupId, 'update-snapshot.sqlite')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('drains leases and captures a committed WAL row in a verified protected snapshot', async () => {
    const currentAttempt = attempt();
    expect(
      (await stat(`${databasePath}-wal`)).size,
    ).toBeGreaterThan(0);
    barrier.enterMaintenance(currentAttempt);
    const metadata = await service.createVerifiedSnapshot(currentAttempt);
    expect(metadata).toMatchObject({
      attemptId: currentAttempt.attemptId,
      fence: currentAttempt.fence,
      integrity: 'ok',
      foreignKeys: 0,
    });
    expect(metadata.path).toBe(
      path.join(
        root,
        'backups',
        currentAttempt.backupId,
        'update-snapshot.sqlite',
      ),
    );
    expect((await stat(metadata.path)).size).toBeGreaterThan(0);
    expect((await readFile(metadata.path)).byteLength).toBe(metadata.bytes);

    const snapshot = await openReadonly(metadata.path);
    try {
      await expect(
        all<{ value: string }>(
          snapshot,
          "SELECT value FROM system_meta WHERE key = 'wal-only'",
        ),
      ).resolves.toEqual([{ value: 'committed' }]);
    } finally {
      await close(snapshot);
    }
  });

  it('waits for an in-flight writer before taking the snapshot', async () => {
    const currentAttempt = attempt();
    const lease = await barrier.acquire('http');
    barrier.enterMaintenance(currentAttempt);

    let snapshotFinished = false;
    const pending = service.createVerifiedSnapshot(currentAttempt).then((value) => {
      snapshotFinished = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(snapshotFinished).toBe(false);

    lease.release();
    await expect(pending).resolves.toMatchObject({ integrity: 'ok' });
  });

  it('irreversibly blocks repository, raw-query, immediate-connection, and storage writes', async () => {
    const currentAttempt = attempt();
    barrier.enterMaintenance(currentAttempt);
    await service.createVerifiedSnapshot(currentAttempt);
    await service.freezeSourceDatabase(currentAttempt);

    await expect(
      dataSource.getRepository(SystemMeta).insert({
        key: 'after-freeze-repository',
        value: 'forbidden',
      }),
    ).rejects.toThrow(/readonly|query_only|permission|write/i);
    await expect(
      dataSource.query(
        `INSERT INTO system_meta (key, value) VALUES ('after-freeze-raw', 'forbidden')`,
      ),
    ).rejects.toThrow(/readonly|query_only|permission|write/i);

    const immediate = new SqliteImmediateTransactionService(
      {
        get: () => dataSource.options.database as string,
      } as any,
      freeze,
    );
    await expect(
      immediate.run(async (connection) => {
        await connection.run(
          `INSERT INTO system_meta (key, value) VALUES ('after-freeze-immediate', 'forbidden')`,
        );
      }),
    ).rejects.toMatchObject({ code: 'UPDATE_SOURCE_FROZEN' });

    const storage = new StorageService(
      {
        get: (key: string) =>
          key === 'app.storagePath'
            ? path.join(root, 'storage')
            : key === 'app.tempPath'
              ? path.join(root, 'temp')
              : undefined,
      } as any,
      freeze,
      barrier,
    );
    await expect(
      storage.writePartToTemp(
        'upload-after-freeze',
        0,
        'owner-01',
        Buffer.from('forbidden'),
        '0'.repeat(64),
      ),
    ).rejects.toMatchObject({ code: 'UPDATE_SOURCE_FROZEN' });

    expect(freeze.isFrozen).toBe(true);
    expect(() => barrier.abortMaintenance(currentAttempt)).toThrow();
  });

  it('rejects unsafe backup identifiers before issuing VACUUM INTO', async () => {
    const currentAttempt = {
      ...attempt(),
      backupId: '../outside',
    };
    barrier.enterMaintenance(currentAttempt);

    await expect(
      service.createVerifiedSnapshot(currentAttempt),
    ).rejects.toThrow(/backup|path|identifier/i);
  });

  it('rejects a backups directory that resolves outside the install root', async () => {
    const outside = path.join(root, 'outside');
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(outside, { recursive: true }),
    );
    await symlink(
      outside,
      path.join(root, 'backups'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const currentAttempt = attempt();
    barrier.enterMaintenance(currentAttempt);

    await expect(
      service.createVerifiedSnapshot(currentAttempt),
    ).rejects.toThrow(/real directory|symlink|outside/i);
    await expect(
      stat(path.join(outside, currentAttempt.backupId)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
import { UpdateSpacePreflightService } from './update-space-preflight.service';
