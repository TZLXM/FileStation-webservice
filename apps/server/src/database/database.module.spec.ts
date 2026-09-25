import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseModule } from './database.module';
import { ConfigModule } from '@nestjs/config';
import configuration from '../config/configuration';
import { DataSource } from 'typeorm';
import { OneTotpAuthenticatorPerAccount1700000000001 } from './migrations/1700000000001-one-totp-authenticator-per-account';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';

describe('DatabaseModule', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let testDbPath: string;
  let testDir: string;

  beforeEach(async () => {
    // 使用临时测试目录（自动清理 WAL 文件）
    testDir = join(tmpdir(), `filestation-test-${uuidv4()}`);
    testDbPath = join(testDir, 'test.db');

    const fs = await import('fs/promises');
    await fs.mkdir(testDir, { recursive: true });

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [() => ({
            app: {
              ...configuration(),
              dbPath: testDbPath,
            },
          })],
          isGlobal: true,
        }),
        DatabaseModule,
      ],
    }).compile();

    // 初始化应用（触发 OnApplicationBootstrap）
    await module.init();

    dataSource = module.get<DataSource>(DataSource);
  });

  afterEach(async () => {
    await module.close();
    // 递归删除临时目录（包含 WAL 文件）
    const fs = await import('fs/promises');
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should be defined', () => {
    expect(module).toBeDefined();
  });

  it('should have WAL mode enabled', async () => {
    const result = await dataSource.query('PRAGMA journal_mode');
    expect(result[0].journal_mode).toBe('wal');
  });

  it('should have busy_timeout set', async () => {
    const result = await dataSource.query('PRAGMA busy_timeout');
    // node-sqlite3 返回列名为 timeout（非 busy_timeout）
    const val = result[0].busy_timeout ?? result[0].timeout;
    expect(Number(val)).toBe(5000);
  });

  it('should have foreign_keys enabled', async () => {
    const result = await dataSource.query('PRAGMA foreign_keys');
    expect(result[0].foreign_keys).toBe(1);
  });

  it('should have transfer_stats_hourly table', async () => {
    const result = await dataSource.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='transfer_stats_hourly'`,
    );
    expect(result.length).toBe(1);
  });

  it('should have required v1.6 indexes', async () => {
    const indexes = await dataSource.query(
      `SELECT name FROM sqlite_master WHERE type='index' AND name IN (
        'idx_folders_parent','idx_upload_sessions_token','idx_upload_sessions_status',
        'idx_shares_file','idx_shares_status','idx_download_sessions_share',
        'idx_transfer_events_time','idx_audit_logs_account','idx_audit_logs_action'
      )`,
    );
    expect(indexes.length).toBe(9);
  });

  it('should have v1.7 upload_sessions lease and target_folder columns', async () => {
    const cols = await dataSource.query(`PRAGMA table_info(upload_sessions)`);
    const names = cols.map((c: any) => c.name);
    expect(names).toContain('verify_owner_token');
    expect(names).toContain('verify_lease_until');
    expect(names).toContain('verify_heartbeat_at');
    expect(names).toContain('target_folder_id');
  });

  it('allows at most one TOTP authenticator per account without restricting WebAuthn rows', async () => {
    const now = Date.now();
    await dataSource.query(
      'INSERT INTO admin_accounts (id, username, password_hash, password_changed_at, created_at, is_active) VALUES (?, ?, ?, ?, ?, ?)',
      ['totp-index-account', 'totp-index-account', 'hash', now, now, 1],
    );
    await dataSource.query(
      'INSERT INTO authenticators (id, account_id, type, name, created_at, is_active) VALUES (?, ?, ?, ?, ?, ?)',
      ['totp-index-one', 'totp-index-account', 'totp', 'TOTP', now, 0],
    );

    await expect(dataSource.query(
      'INSERT INTO authenticators (id, account_id, type, name, created_at, is_active) VALUES (?, ?, ?, ?, ?, ?)',
      ['totp-index-two', 'totp-index-account', 'totp', 'TOTP', now + 1, 0],
    )).rejects.toThrow();

    await dataSource.query(
      'INSERT INTO authenticators (id, account_id, type, name, created_at, is_active) VALUES (?, ?, ?, ?, ?, ?)',
      ['webauthn-index-one', 'totp-index-account', 'webauthn', 'WebAuthn', now + 2, 1],
    );
    await dataSource.query(
      'INSERT INTO authenticators (id, account_id, type, name, created_at, is_active) VALUES (?, ?, ?, ?, ?, ?)',
      ['webauthn-index-two', 'totp-index-account', 'webauthn', 'WebAuthn', now + 3, 1],
    );
  });

  it('makes the TOTP uniqueness migration down safe to run more than once', async () => {
    const migration = new OneTotpAuthenticatorPerAccount1700000000001();
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await expect(migration.down(queryRunner)).resolves.toBeUndefined();
      await expect(migration.down(queryRunner)).resolves.toBeUndefined();
    } finally {
      await queryRunner.release();
    }
  });
});
