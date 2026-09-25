import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sqlite3 = require('sqlite3');

export interface SqliteRunResult {
  changes: number;
  lastID: number;
}

export interface SqliteTransactionConnection {
  run(sql: string, parameters?: unknown[]): Promise<SqliteRunResult>;
  get<T>(sql: string, parameters?: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, parameters?: unknown[]): Promise<T[]>;
}

class PromiseSqliteConnection implements SqliteTransactionConnection {
  constructor(private readonly database: sqlite3.Database) {}

  run(sql: string, parameters: unknown[] = []): Promise<SqliteRunResult> {
    return new Promise((resolve, reject) => {
      this.database.run(sql, parameters, function (error) {
        if (error) {
          reject(error);
          return;
        }
        resolve({ changes: this.changes, lastID: this.lastID });
      });
    });
  }

  get<T>(sql: string, parameters: unknown[] = []): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      this.database.get<T>(sql, parameters, (error, row) => {
        if (error) reject(error);
        else resolve(row);
      });
    });
  }

  all<T>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.database.all<T>(sql, parameters, (error, rows) => {
        if (error) reject(error);
        else resolve(rows);
      });
    });
  }
}

@Injectable()
export class SqliteImmediateTransactionService {
  // Concurrent busy-timeout waits can starve libuv workers needed by the lock owner.
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(private readonly configService: ConfigService) {}

  async run<T>(work: (connection: SqliteTransactionConnection) => Promise<T>): Promise<T> {
    // Queue before opening a connection or issuing BEGIN IMMEDIATE.
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;

    try {
      return await this.runWithExclusiveConnection(work);
    } finally {
      release();
    }
  }

  private async runWithExclusiveConnection<T>(
    work: (connection: SqliteTransactionConnection) => Promise<T>,
  ): Promise<T> {
    const databasePath = this.configService.get<string>('app.dbPath');
    if (!databasePath || databasePath === ':memory:' || databasePath.includes('mode=memory')) {
      throw new Error('SQLite immediate transactions require the configured file-backed database path');
    }

    const database = await this.open(databasePath);
    const connection = new PromiseSqliteConnection(database);
    let transactionStarted = false;
    try {
      database.configure('busyTimeout', 5000);
      await connection.run('PRAGMA foreign_keys = ON');
      await connection.run('BEGIN IMMEDIATE');
      transactionStarted = true;

      const result = await work(connection);
      await connection.run('COMMIT');
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await connection.run('ROLLBACK');
        } catch {
          // Preserve the operation error when no transaction remains to roll back.
        }
      }
      throw error;
    } finally {
      await this.close(database);
    }
  }

  private open(databasePath: string): Promise<sqlite3.Database> {
    return new Promise((resolve, reject) => {
      const database = new sqlite3.Database(
        databasePath,
        sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_FULLMUTEX,
        (error) => {
          if (error) reject(error);
          else resolve(database);
        },
      );
    });
  }

  private close(database: sqlite3.Database): Promise<void> {
    return new Promise((resolve, reject) => {
      database.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}
