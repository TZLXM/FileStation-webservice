import { UploadsService } from './uploads.service';
import { WriteBarrierService } from '../maintenance/write-barrier.service';
import { WriteFreezeService } from '../maintenance/write-freeze.service';

describe('UploadsService maintenance finalization', () => {
  const uploads = { findOne: jest.fn(), findOneBy: jest.fn(), update: jest.fn() };
  const parts = { find: jest.fn() };
  const files = { save: jest.fn() };
  const folders = { findOne: jest.fn() };
  const storage = { deleteUploadTempDir: jest.fn() };
  const settings = { getStorageSettings: jest.fn() };
  const dataSource = { query: jest.fn() };
  const sqlite = { run: jest.fn() };

  let barrier: WriteBarrierService;
  let service: UploadsService;

  beforeEach(() => {
    jest.clearAllMocks();
    const freeze = new WriteFreezeService();
    barrier = new WriteBarrierService(freeze);
    service = new UploadsService(
      uploads as any,
      parts as any,
      files as any,
      folders as any,
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
  });

  it('rejects a new completion before token or database work once maintenance closes', async () => {
    barrier.enterMaintenance({
      attemptId: 'attempt-01',
      fence: 1,
      installRoot: 'C:\\fixture',
      backupId: 'backup-01',
      targetVersion: '0.2.5',
    });

    await expect(
      service.completeUpload('upload-01', 'upload-token'),
    ).rejects.toMatchObject({ code: 'UPDATE_MAINTENANCE' });
    expect(uploads.findOne).not.toHaveBeenCalled();
    expect(barrier.activeLeaseCount).toBe(0);
  });

  it('keeps a counted finalizer lease after the HTTP lease starts closing', async () => {
    const requestLease = await barrier.acquire('http');
    barrier.attachContext(requestLease);
    const finalizer = await barrier.forkLease('upload-finalizer');
    barrier.enterMaintenance({
      attemptId: 'attempt-01',
      fence: 1,
      installRoot: 'C:\\fixture',
      backupId: 'backup-01',
      targetVersion: '0.2.5',
    });

    requestLease.release();
    expect(barrier.activeLeaseCount).toBe(1);
    const drained = barrier.waitForZero(Date.now() + 1_000);
    finalizer.release();
    await expect(drained).resolves.toBeUndefined();
  });
});
