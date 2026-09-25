import { DataSource } from 'typeorm';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SystemMeta } from '../../auth/entities/system-meta.entity';
import { SqliteImmediateTransactionService } from './sqlite-immediate-transaction.service';

describe('SQLite transaction connection isolation', () => {
  let dataSource: DataSource;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'filestation-sqlite-tx-'));
    dataSource = new DataSource({
      type: 'sqlite',
      database: join(directory, 'test.db'),
      entities: [SystemMeta],
      synchronize: true,
    });
    await dataSource.initialize();
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('does not roll back an ordinary Repository insert interleaved with an immediate transaction', async () => {
    const repository = dataSource.getRepository(SystemMeta);
    const transactionService = new SqliteImmediateTransactionService({
      get: () => join(directory, 'test.db'),
    } as any);
    let signalTransactionStarted!: () => void;
    const transactionStarted = new Promise<void>((resolve) => { signalTransactionStarted = resolve; });
    let allowRollback!: () => void;
    const rollbackGate = new Promise<void>((resolve) => { allowRollback = resolve; });

    const transaction = transactionService.run(async (connection) => {
      const foreignKeys = await connection.get<{ foreign_keys: number }>('PRAGMA foreign_keys');
      const busyTimeout = await connection.get<{ timeout?: number; busy_timeout?: number }>('PRAGMA busy_timeout');
      expect(foreignKeys?.foreign_keys).toBe(1);
      expect(Number(busyTimeout?.timeout ?? busyTimeout?.busy_timeout)).toBe(5000);
      await connection.run('INSERT INTO system_meta (key, value) VALUES (?, ?)', ['transaction-write', 'rolled-back']);
      signalTransactionStarted();
      await rollbackGate;
      throw new Error('force rollback');
    });

    await transactionStarted;
    // The Repository call is issued while the independent connection owns the
    // SQLite write lock; it must run after rollback as its own autocommit write.
    const repositoryWrite = repository.insert({ key: 'repository-write', value: 'committed' });
    allowRollback();
    await expect(transaction).rejects.toThrow('force rollback');
    await repositoryWrite;

    await expect(repository.findOneBy({ key: 'transaction-write' })).resolves.toBeNull();
    await expect(repository.findOneBy({ key: 'repository-write' })).resolves.toMatchObject({ value: 'committed' });
  });

  it('keeps an earlier ordinary Repository commit when an independent transaction rolls back', async () => {
    const repository = dataSource.getRepository(SystemMeta);
    const transactionService = new SqliteImmediateTransactionService({
      get: () => join(directory, 'test.db'),
    } as any);
    await repository.insert({ key: 'repository-write', value: 'committed' });

    await expect(transactionService.run(async (connection) => {
      await connection.run('INSERT INTO system_meta (key, value) VALUES (?, ?)', ['transaction-write', 'rolled-back']);
      throw new Error('force rollback');
    })).rejects.toThrow('force rollback');

    await expect(repository.findOneBy({ key: 'repository-write' })).resolves.toMatchObject({ value: 'committed' });
    await expect(repository.findOneBy({ key: 'transaction-write' })).resolves.toBeNull();
  });

  it('finishes concurrent transactions without starving the connection holding the write lock', async () => {
    const repository = dataSource.getRepository(SystemMeta);
    const transactionService = new SqliteImmediateTransactionService({
      get: () => join(directory, 'test.db'),
    } as any);
    const count = 8;
    await repository.insert({ key: 'seed', value: 'present' });

    const results = await Promise.allSettled(Array.from({ length: count }, (_, index) =>
      transactionService.run(async (connection) => {
        const current = await connection.get<{ value: string }>(
          'SELECT value FROM system_meta WHERE key = ?',
          ['seed'],
        );
        await connection.run(
          'INSERT INTO system_meta (key, value) VALUES (?, ?)',
          [`transaction-${index}`, current?.value ?? 'missing'],
        );
        return current?.value ?? 'missing';
      }),
    ));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    const observedValues = results.map((result) => result.status === 'fulfilled' ? result.value : 'missing');

    expect(observedValues).toEqual(Array(count).fill('present'));
    expect(await repository.count()).toBe(count + 1);
  }, 15_000);
});
