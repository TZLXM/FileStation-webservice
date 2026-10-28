import { createHash } from 'node:crypto';
import {
  createReadStream,
  promises as fs,
} from 'node:fs';
import path from 'node:path';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import sqlite3 = require('sqlite3');
import {
  DurableFileSystem,
  NodeDurableFileSystem,
} from '@filestation/updater';
import { WriteBarrierService } from '../maintenance/write-barrier.service';
import {
  MaintenanceAttempt,
  WriteFreezeService,
} from '../maintenance/write-freeze.service';

export interface SnapshotMetadata {
  attemptId: string;
  fence: number;
  path: string;
  sha256: string;
  bytes: number;
  sourceDatabase: string;
  integrity: 'ok';
  foreignKeys: 0;
  createdAt: string;
}

interface SnapshotConnection {
  all<T>(sql: string, parameters?: unknown[]): Promise<T[]>;
}

const SAFE_BACKUP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SNAPSHOT_DRAIN_TIMEOUT_MS = 60_000;

function within(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative.length > 0 &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === 'win32'
      ? path.resolve(value).toLowerCase()
      : path.resolve(value);
  return normalize(left) === normalize(right);
}

function hashFile(filename: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filename);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function openReadonly(filename: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(
      filename,
      sqlite3.OPEN_READONLY | sqlite3.OPEN_FULLMUTEX,
      (error) => (error ? reject(error) : resolve(database)),
    );
  });
}

function all<T>(
  connection: sqlite3.Database,
  sql: string,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    connection.all(sql, (error, rows) =>
      error ? reject(error) : resolve(rows as T[]),
    );
  });
}

function close(connection: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.close((error) => (error ? reject(error) : resolve()));
  });
}

async function verify(
  label: string,
  integrityRows: Array<{ integrity_check: string }>,
  foreignKeyRows: Record<string, unknown>[],
): Promise<void> {
  if (
    integrityRows.length !== 1 ||
    integrityRows[0]?.integrity_check !== 'ok'
  ) {
    throw new Error(`${label} SQLite integrity_check failed`);
  }
  if (foreignKeyRows.length !== 0) {
    throw new Error(`${label} SQLite foreign_key_check found violations`);
  }
}

@Injectable()
export class DatabaseSnapshotService {
  private readonly durable: DurableFileSystem;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly barrier: WriteBarrierService,
    private readonly freeze: WriteFreezeService,
    @Optional()
    durable?: DurableFileSystem,
  ) {
    this.durable = durable ?? new NodeDurableFileSystem();
  }

  async createVerifiedSnapshot(
    attempt: MaintenanceAttempt,
  ): Promise<SnapshotMetadata> {
    this.assertMaintenanceOwned(attempt);
    if (!path.isAbsolute(attempt.installRoot)) {
      throw new Error('snapshot install root must be absolute');
    }
    if (!SAFE_BACKUP_ID.test(attempt.backupId)) {
      throw new Error('backup identifier is unsafe for snapshot path');
    }

    await this.barrier.waitForZero(Date.now() + SNAPSHOT_DRAIN_TIMEOUT_MS);
    this.assertMaintenanceOwned(attempt);

    const sourceDatabase = this.config.get<string>('app.dbPath');
    if (!sourceDatabase || sourceDatabase === ':memory:') {
      throw new Error('snapshot requires a configured file-backed SQLite database');
    }
    const canonicalInstallRoot = path.resolve(attempt.installRoot);
    const backupsRoot = path.join(canonicalInstallRoot, 'backups');
    const destinationDirectory = path.join(backupsRoot, attempt.backupId);
    const output = path.join(destinationDirectory, 'update-snapshot.sqlite');
    if (!within(backupsRoot, output)) {
      throw new Error('snapshot destination is outside protected backups');
    }
    if (await this.durable.exists(output)) {
      throw new Error(`snapshot output already exists: ${output}`);
    }

    if (await this.durable.exists(backupsRoot)) {
      const backupsStat = await this.durable.lstat(backupsRoot);
      if (!backupsStat.isDirectory() || backupsStat.isSymbolicLink()) {
        throw new Error('protected backups path must be a real directory');
      }
    } else {
      await this.durable.ensurePrivateDirectory(backupsRoot);
    }
    if (!samePath(await this.durable.realpath(backupsRoot), backupsRoot)) {
      throw new Error('protected backups path escapes through a symlink');
    }
    await this.durable.ensurePrivateDirectory(backupsRoot);
    if (await this.durable.exists(destinationDirectory)) {
      const destinationStat =
        await this.durable.lstat(destinationDirectory);
      if (
        !destinationStat.isDirectory() ||
        destinationStat.isSymbolicLink()
      ) {
        throw new Error('snapshot backup directory must be a real directory');
      }
    }
    await this.durable.ensurePrivateDirectory(destinationDirectory);
    let snapshotConnection: sqlite3.Database | undefined;
    try {
      const [sourceIntegrity, sourceForeignKeys] = await Promise.all([
        this.dataSource.query(
          'PRAGMA integrity_check',
        ) as Promise<Array<{ integrity_check: string }>>,
        this.dataSource.query(
          'PRAGMA foreign_key_check',
        ) as Promise<Record<string, unknown>[]>,
      ]);
      await verify('source', sourceIntegrity, sourceForeignKeys);

      await this.dataSource.query('VACUUM INTO ?', [output]);
      await this.durable.protect(output, false);

      snapshotConnection = await openReadonly(output);
      const [snapshotIntegrity, snapshotForeignKeys] = await Promise.all([
        all<{ integrity_check: string }>(
          snapshotConnection,
          'PRAGMA integrity_check',
        ),
        all<Record<string, unknown>>(
          snapshotConnection,
          'PRAGMA foreign_key_check',
        ),
      ]);
      await verify(
        'snapshot',
        snapshotIntegrity,
        snapshotForeignKeys,
      );
      const info = await fs.stat(output);
      return {
        attemptId: attempt.attemptId,
        fence: attempt.fence,
        path: output,
        sha256: await hashFile(output),
        bytes: info.size,
        sourceDatabase: path.resolve(sourceDatabase),
        integrity: 'ok',
        foreignKeys: 0,
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      await this.durable.unlink(output).catch(() => {});
      throw error;
    } finally {
      if (snapshotConnection) await close(snapshotConnection).catch(() => {});
    }
  }

  async freezeSourceDatabase(attempt: MaintenanceAttempt): Promise<void> {
    this.assertMaintenanceOwned(attempt);
    await this.barrier.waitForZero(Date.now() + SNAPSHOT_DRAIN_TIMEOUT_MS);
    this.assertMaintenanceOwned(attempt);
    await this.dataSource.query('PRAGMA query_only = ON');
    this.freeze.freeze(attempt);
    const rows = (await this.dataSource.query(
      'PRAGMA query_only',
    )) as Array<Record<string, unknown>>;
    const queryOnly =
      rows[0]?.query_only ??
      rows[0]?.queryOnly;
    if (Number(queryOnly) !== 1) {
      throw new Error('SQLite query_only was not enabled after source freeze');
    }
  }

  private assertMaintenanceOwned(attempt: MaintenanceAttempt): void {
    const current = this.barrier.currentAttempt;
    if (
      !current ||
      current.attemptId !== attempt.attemptId ||
      current.fence !== attempt.fence
    ) {
      throw new Error(
        'snapshot attempt or fence does not own the closed write barrier',
      );
    }
  }
}
