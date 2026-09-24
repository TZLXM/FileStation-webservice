import { DataSource } from 'typeorm';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir, rm } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { ApiToken } from '../api-tokens/entities/api-token.entity';
import { Authenticator } from '../auth/entities/authenticator.entity';
import { RecoveryCode } from '../auth/entities/recovery-code.entity';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { InitialSchema1700000000000 } from '../database/migrations/1700000000000-initial-schema';

// 真实迁移建库（synchronize: false + migrationsRun）：
// 迁移 DDL 是权威 schema，实体必须贴合它
describe('Phase 2 entities alignment (real migration)', () => {
  let dir: string;
  let ds: DataSource;

  beforeAll(async () => {
    dir = join(tmpdir(), `fs-align-${uuidv4()}`);
    await mkdir(dir, { recursive: true });
    ds = new DataSource({
      type: 'sqlite',
      database: join(dir, 'test.db'),
      entities: [ApiToken, Authenticator, RecoveryCode, AuditLog],
      migrations: [InitialSchema1700000000000],
      migrationsRun: true,
      synchronize: false,
    });
    await ds.initialize();
    // TypeORM sqlite 驱动连接后无条件 PRAGMA foreign_keys = ON；
    // 本 spec 只测实体-表对齐，不插 admin_accounts 行，故建库后关闭外键约束
    await ds.query('PRAGMA foreign_keys = OFF');
  });

  afterAll(async () => {
    await ds.destroy();
    await rm(dir, { recursive: true, force: true });
  });

  it('实体列名与迁移 DDL 逐列吻合（防漂移）', async () => {
    const cases: Array<[any, string]> = [
      [ApiToken, 'api_tokens'],
      [Authenticator, 'authenticators'],
      [RecoveryCode, 'recovery_codes'],
      [AuditLog, 'audit_logs'],
    ];
    for (const [entity, table] of cases) {
      const metaCols = ds.getMetadata(entity).columns.map((c) => c.databaseName).sort();
      const dbCols = (await ds.query(`PRAGMA table_info(${table})`)).map((c: any) => c.name).sort();
      expect(metaCols).toEqual(dbCols);
    }
  });

  it('ApiToken 实体可读写迁移表', async () => {
    await ds.getRepository(ApiToken).save({
      id: 't1', accountId: 'a1', name: 'cli', tokenPrefix: 'fs_api_ab12',
      tokenHash: 'x'.repeat(64), scopes: '["files:read"]', expiresAt: null,
      createdAt: Date.now(), lastUsedAt: null, lastUsedIp: null, revokedAt: null,
    });
    const row = await ds.getRepository(ApiToken).findOneBy({ id: 't1' });
    expect(row?.tokenPrefix).toBe('fs_api_ab12');
  });

  it('Authenticator/RecoveryCode/AuditLog 实体可读写迁移表', async () => {
    await ds.getRepository(Authenticator).save({
      id: 'au1', accountId: 'a1', type: 'totp', name: 'TOTP',
      totpSecretEncrypted: 'v1.x.y.z', credentialId: null, publicKey: null,
      signCount: 0, transports: null, createdAt: Date.now(), lastUsedAt: null, isActive: 1,
    });
    await ds.getRepository(RecoveryCode).save({
      id: 'r1', accountId: 'a1', codeHash: 'argon2...', usedAt: null,
      createdAt: Date.now(), expiresAt: Date.now() + 86400_000,
    });
    await ds.getRepository(AuditLog).save({
      id: 'l1', accountId: 'a1', action: 'auth.login', resourceType: null,
      resourceId: null, details: null, ipAddress: '192.168.1.0',
      userAgent: 'jest', createdAt: Date.now(),
    });
    expect(await ds.getRepository(AuditLog).count()).toBe(1);
  });
});
