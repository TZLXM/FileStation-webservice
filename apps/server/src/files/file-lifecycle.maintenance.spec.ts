import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLifecycleService } from './file-lifecycle.service';
import { WriteBarrierService } from '../maintenance/write-barrier.service';
import { WriteFreezeService } from '../maintenance/write-freeze.service';

describe('FileLifecycleService background gating', () => {
  const files = { update: jest.fn(), find: jest.fn(), count: jest.fn() };
  const uploads = { find: jest.fn(), update: jest.fn(), findOne: jest.fn() };
  const storage = {
    getTempRoot: jest.fn(),
    getStorageRoot: jest.fn(),
    deleteUploadTempDir: jest.fn(),
    deleteTempPart: jest.fn(),
    deleteFile: jest.fn(),
    getFileStats: jest.fn(),
    calculateFileHash: jest.fn(),
    combineParts: jest.fn(),
    getFinalPath: jest.fn(),
  };
  const settings = { getStorageSettings: jest.fn() };
  const dataSource = { query: jest.fn(), createQueryRunner: jest.fn() };
  const sqlite = { run: jest.fn() };

  let root: string;
  let freeze: WriteFreezeService;
  let barrier: WriteBarrierService;
  let service: FileLifecycleService;

  beforeEach(async () => {
    jest.clearAllMocks();
    root = await mkdtemp(path.join(tmpdir(), 'filestation-task7-lifecycle-'));
    freeze = new WriteFreezeService();
    barrier = new WriteBarrierService(freeze);
    service = new FileLifecycleService(
      files as any,
      uploads as any,
      storage as any,
      settings as any,
      dataSource as any,
      sqlite as any,
      barrier,
      freeze,
    );
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    await rm(root, { recursive: true, force: true });
  });

  it('does not run the startup scan from Nest bootstrap hooks', async () => {
    service.onApplicationBootstrap();

    expect(files.update).not.toHaveBeenCalled();
    expect(uploads.find).not.toHaveBeenCalled();
    expect(storage.deleteUploadTempDir).not.toHaveBeenCalled();
  });

  it('returns Cron work before any write while background activation is closed', async () => {
    await expect(service.expireFiles()).resolves.toBe(0);

    expect(files.update).not.toHaveBeenCalled();
    expect(barrier.activeLeaseCount).toBe(0);
  });

  it('acquires a startup-scan lease and then permits Cron work guarded by its own lease', async () => {
    const scan = jest
      .spyOn(service, 'scanOrphanTempFiles')
      .mockResolvedValue(undefined);
    const expire = jest.spyOn(service, 'expireFiles').mockResolvedValue(0);
    const deletes = jest
      .spyOn(service, 'processDeletes')
      .mockResolvedValue(undefined);
    const expiredUploads = jest
      .spyOn(service, 'cleanupExpiredUploadSessions')
      .mockResolvedValue(undefined);
    const recovery = jest
      .spyOn(service, 'recoverVerifyingUploads')
      .mockResolvedValue(undefined);

    await service.activate();

    expect(expire).toHaveBeenCalledTimes(1);
    expect(deletes).toHaveBeenCalledTimes(1);
    expect(expiredUploads).toHaveBeenCalledTimes(1);
    expect(recovery).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(barrier.activeLeaseCount).toBe(0);

    expire.mockRestore();
    deletes.mockRestore();
    expiredUploads.mockRestore();
    recovery.mockRestore();
    scan.mockRestore();

    files.update.mockResolvedValue({ affected: 0 });
    await service.expireFiles();
    expect(files.update).toHaveBeenCalledTimes(1);
    expect(barrier.activeLeaseCount).toBe(0);
  });

  it('skips background Cron work once maintenance closes the barrier', async () => {
    const expire = jest.spyOn(service, 'expireFiles').mockResolvedValue(0);
    const deletes = jest
      .spyOn(service, 'processDeletes')
      .mockResolvedValue(undefined);
    const expiredUploads = jest
      .spyOn(service, 'cleanupExpiredUploadSessions')
      .mockResolvedValue(undefined);
    const recovery = jest
      .spyOn(service, 'recoverVerifyingUploads')
      .mockResolvedValue(undefined);
    const scan = jest
      .spyOn(service, 'scanOrphanTempFiles')
      .mockResolvedValue(undefined);
    await service.activate();
    expire.mockRestore();
    deletes.mockRestore();
    expiredUploads.mockRestore();
    recovery.mockRestore();
    scan.mockRestore();

    barrier.enterMaintenance({
      attemptId: 'attempt-01',
      fence: 1,
      installRoot: root,
      backupId: 'backup-01',
      targetVersion: '0.2.5',
    });

    await expect(service.expireFiles()).resolves.toBe(0);
    expect(files.update).not.toHaveBeenCalled();
  });

  it('does not unlink orphan storage files after the frozen latch is set', async () => {
    const tempRoot = path.join(root, 'temp');
    const uploadDir = path.join(tempRoot, 'upload-01');
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(uploadDir, { recursive: true }),
    );
    const orphan = path.join(uploadDir, 'part_000000.part.tmp');
    await writeFile(orphan, 'orphan');
    storage.getTempRoot.mockReturnValue(tempRoot);
    storage.getStorageRoot.mockReturnValue(path.join(root, 'storage'));
    dataSource.query.mockResolvedValue([]);

    const startupMethods = [
      jest.spyOn(service, 'expireFiles').mockResolvedValue(0),
      jest.spyOn(service, 'processDeletes').mockResolvedValue(undefined),
      jest
        .spyOn(service, 'cleanupExpiredUploadSessions')
        .mockResolvedValue(undefined),
      jest
        .spyOn(service, 'recoverVerifyingUploads')
        .mockResolvedValue(undefined),
      jest.spyOn(service, 'scanOrphanTempFiles').mockResolvedValue(undefined),
    ];
    await service.activate();
    for (const method of startupMethods) method.mockRestore();

    freeze.freeze({
      attemptId: 'attempt-01',
      fence: 1,
      installRoot: root,
      backupId: 'backup-01',
      targetVersion: '0.2.5',
    });

    await expect(service.scanOrphanTempFiles()).resolves.toBeUndefined();
    await expect(readdir(uploadDir)).resolves.toEqual([
      'part_000000.part.tmp',
    ]);
  });
});
