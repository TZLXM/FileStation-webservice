import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sqlite3 = require('sqlite3');
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

  const seal = () => freeze.freeze({ attemptId: 'attempt-01', fence: 1,
    installRoot: root, backupId: 'backup-01', targetVersion: '0.2.5' });

  it('releases the queued tail when freeze occurs while waiting for its predecessor', async () => {
    let resume!: () => void;
    (service as any).transactionTail = new Promise<void>((resolve) => { resume = resolve; });
    const work = jest.fn(async () => undefined);
    const pending = service.run(work);
    const tail: Promise<void> = (service as any).transactionTail;
    let released = false;
    void tail.then(() => { released = true; });
    seal();
    resume();
    await expect(pending).rejects.toMatchObject({ code: 'UPDATE_SOURCE_FROZEN' });
    await Promise.resolve();
    expect(released).toBe(true);
    expect(work).not.toHaveBeenCalled();
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it('actually closes the opened connection when freeze occurs during async open', async () => {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let opened!: (database: sqlite3.Database) => void;
    const ready = new Promise<sqlite3.Database>((resolve) => { opened = resolve; });
    const originalOpen = (service as any).open.bind(service);
    jest.spyOn(service as any, 'open').mockImplementation(async (filename: unknown) => {
      const database = await originalOpen(filename);
      opened(database);
      await gate;
      return database;
    });
    const work = jest.fn(async () => undefined);
    const pending = service.run(work);
    const database = await ready;
    const closeSpy = jest.spyOn(database, 'close');
    seal();
    resume();
    try {
      await expect(pending).rejects.toMatchObject({ code: 'UPDATE_SOURCE_FROZEN' });
      expect(closeSpy).toHaveBeenCalledTimes(1);
      const queryError = await new Promise<Error | null>((resolve) => {
        database.get('SELECT 1', (error) => resolve(error));
      });
      expect(queryError).toMatchObject({ code: 'SQLITE_MISUSE' });
      expect(work).not.toHaveBeenCalled();
    } finally {
      if (closeSpy.mock.calls.length === 0) {
        await new Promise<void>((resolve, reject) => database.close((error) => error ? reject(error) : resolve()));
      }
    }
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
