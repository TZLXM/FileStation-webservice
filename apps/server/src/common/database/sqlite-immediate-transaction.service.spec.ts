import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WriteFreezeService } from '../../maintenance/write-freeze.service';
import { SqliteImmediateTransactionService } from './sqlite-immediate-transaction.service';

describe('SqliteImmediateTransactionService freeze gate', () => {
  let root: string;
  let freeze: WriteFreezeService;
  let service: SqliteImmediateTransactionService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'filestation-task7-immediate-'));
    freeze = new WriteFreezeService();
    service = new SqliteImmediateTransactionService(
      {
        get: () => path.join(root, 'database.sqlite'),
      } as any,
      freeze,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('checks the shared frozen latch before opening a new connection or BEGIN', async () => {
    freeze.freeze({
      attemptId: 'attempt-01',
      fence: 1,
      installRoot: root,
      backupId: 'backup-01',
      targetVersion: '0.2.5',
    });

    await expect(service.run(async () => undefined)).rejects.toMatchObject({
      code: 'UPDATE_SOURCE_FROZEN',
    });
    await expect(readdir(root)).resolves.toEqual([]);
  });
});
