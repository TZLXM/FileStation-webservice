import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WriteBarrierService } from '../maintenance/write-barrier.service';
import { WriteFreezeService } from '../maintenance/write-freeze.service';
import { StorageService } from './storage.service';

describe('StorageService write freeze', () => {
  let root: string;
  let storage: string;
  let temp: string;
  let barrier: WriteBarrierService;
  let freeze: WriteFreezeService;
  let service: StorageService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'filestation-task7-storage-'));
    storage = path.join(root, 'storage');
    temp = path.join(root, 'temp');
    freeze = new WriteFreezeService();
    barrier = new WriteBarrierService(freeze);
    service = new StorageService(
      {
        get: (key: string) =>
          key === 'app.storagePath'
            ? storage
            : key === 'app.tempPath'
              ? temp
              : undefined,
      } as any,
      freeze,
      barrier,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates storage directories only when explicitly activated', async () => {
    await expect(readdir(storage)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(temp)).rejects.toMatchObject({ code: 'ENOENT' });

    await service.activate();

    await expect(readdir(storage)).resolves.toEqual([]);
    await expect(readdir(temp)).resolves.toEqual([]);
  });

  it('rejects every storage writer after the shared frozen latch is set', async () => {
    await service.activate();
    freeze.freeze({
      attemptId: 'attempt-01',
      fence: 1,
      installRoot: root,
      backupId: 'backup-01',
      targetVersion: '0.2.5',
    });

    await expect(
      service.writePartToTemp(
        'upload-01',
        0,
        'owner-01',
        Buffer.from('forbidden'),
        '0'.repeat(64),
      ),
    ).rejects.toMatchObject({ code: 'UPDATE_SOURCE_FROZEN' });
    await expect(service.deleteUploadTempDir('upload-01')).rejects.toMatchObject({
      code: 'UPDATE_SOURCE_FROZEN',
    });
    await expect(service.ensureDirectories()).rejects.toMatchObject({
      code: 'UPDATE_SOURCE_FROZEN',
    });
  });
});
