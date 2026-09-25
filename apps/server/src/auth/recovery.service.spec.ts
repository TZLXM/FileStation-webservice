import * as argon2 from 'argon2';
import * as bcrypt from 'bcrypt';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource, Repository } from 'typeorm';
import { AccountsService } from '../accounts/accounts.service';
import { AdminAccount } from '../accounts/entities/admin-account.entity';
import { InitialSchema1700000000000 } from '../database/migrations/1700000000000-initial-schema';
import { SqliteImmediateTransactionService } from '../common/database/sqlite-immediate-transaction.service';
import { AuditService } from '../audit/audit.service';
import { Authenticator } from './entities/authenticator.entity';
import { RecoveryCode } from './entities/recovery-code.entity';
import { Session } from './entities/session.entity';
import { SystemMeta } from './entities/system-meta.entity';
import type { RecoverySessionMaterial } from './recovery.service';
import { v4 as uuidv4 } from 'uuid';

type RecoveryServiceModule = { RecoveryService: new (...args: any[]) => any };

function loadRecoveryService(): RecoveryServiceModule | null {
  try {
    return require('./recovery.service') as RecoveryServiceModule;
  } catch {
    return null;
  }
}

describe('RecoveryService', () => {
  jest.setTimeout(60_000);

  const recoveryModule = loadRecoveryService();
  let dataSource: DataSource | null = null;
  let directory = '';
  let dbPath = '';
  let accountRepository: Repository<AdminAccount>;
  let codeRepository: Repository<RecoveryCode>;
  let sessionRepository: Repository<Session>;
  let metaRepository: Repository<SystemMeta>;
  let service: any;
  let totpEnabled = false;
  const accountsService = new AccountsService({} as Repository<AdminAccount>);
  const totpService = {
    hasActiveTotp: jest.fn(async () => totpEnabled),
    verifyCode: jest.fn().mockResolvedValue(true),
  };
  const auditService = { record: jest.fn().mockResolvedValue(undefined) };
  let passwordHash = '';

  function preparedSessionMaterial(): RecoverySessionMaterial {
    const id = uuidv4();
    const now = Date.now();
    return {
      id,
      accountId: 'account-1',
      refreshTokenHash: `prepared-refresh-hash-${id}`,
      createdAt: now,
      expiresAt: now + 7 * 24 * 60 * 60 * 1000,
    };
  }

  beforeAll(async () => {
    if (!recoveryModule) return;
    directory = await mkdtemp(join(tmpdir(), 'filestation-recovery-'));
    dbPath = join(directory, 'test.db');
    dataSource = new DataSource({
      type: 'sqlite',
      database: dbPath,
      entities: [AdminAccount, RecoveryCode, Session, SystemMeta, Authenticator],
      migrations: [InitialSchema1700000000000],
      migrationsRun: true,
      synchronize: false,
    });
    await dataSource.initialize();
    accountRepository = dataSource.getRepository(AdminAccount);
    codeRepository = dataSource.getRepository(RecoveryCode);
    sessionRepository = dataSource.getRepository(Session);
    metaRepository = dataSource.getRepository(SystemMeta);
    (accountsService as any).accountsRepository = accountRepository;
    passwordHash = await bcrypt.hash('current-password', 10);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (!recoveryModule || !dataSource) return;
    await dataSource.query('DELETE FROM recovery_codes');
    await dataSource.query('DELETE FROM sessions');
    await dataSource.query('DELETE FROM system_meta');
    await dataSource.query('DELETE FROM authenticators');
    await dataSource.query('DELETE FROM admin_accounts');
    await accountRepository.save({
      id: 'account-1',
      username: 'admin',
      passwordHash,
      passwordChangedAt: Date.now(),
      createdAt: Date.now(),
      isActive: 1,
    });
    totpEnabled = false;
    totpService.hasActiveTotp.mockClear();
    totpService.verifyCode.mockClear().mockResolvedValue(true);
    auditService.record.mockClear().mockResolvedValue(undefined);
    const transactionService = new SqliteImmediateTransactionService({ get: () => dbPath } as any);
    service = new recoveryModule.RecoveryService(
      codeRepository,
      accountsService,
      totpService,
      auditService as unknown as AuditService,
      transactionService,
    );
  });

  function requireService(): any | null {
    expect(recoveryModule).not.toBeNull();
    if (!recoveryModule || !service) return null;
    return service;
  }

  it('generates ten formatted codes and persists only Argon2id hashes with a 24-hour expiry', async () => {
    const subject = requireService();
    if (!subject) return;

    const codes: string[] = await subject.generate('account-1', 'current-password');
    const rows = await codeRepository.findBy({ accountId: 'account-1' });

    expect(codes).toHaveLength(10);
    expect(codes.every((code) => /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/.test(code))).toBe(true);
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.codeHash.startsWith('$argon2id$'))).toBe(true);
    expect(rows.every((row) => row.expiresAt - row.createdAt === 24 * 60 * 60 * 1000)).toBe(true);
    expect(rows.every((row) => codes.every((code) => !row.codeHash.includes(code)))).toBe(true);
    expect(await argon2.verify(rows[0].codeHash, codes[0].replace(/-/g, ''))).toBe(true);
    expect(auditService.record).toHaveBeenCalledWith({ accountId: 'account-1', action: 'recovery.generated' });
    expect(JSON.stringify(auditService.record.mock.calls)).not.toContain(codes[0]);
  });

  it('requires the current password and a valid TOTP code when TOTP is active', async () => {
    const subject = requireService();
    if (!subject) return;

    await expect(subject.generate('account-1', 'incorrect-password')).rejects.toMatchObject({ status: 401 });
    expect(await codeRepository.countBy({ accountId: 'account-1' })).toBe(0);

    totpEnabled = true;
    totpService.verifyCode.mockResolvedValue(false);
    await expect(subject.generate('account-1', 'current-password', '000000'))
      .rejects.toMatchObject({ response: { code: 'TOTP_REQUIRED' } });
    expect(await codeRepository.countBy({ accountId: 'account-1' })).toBe(0);

    totpService.verifyCode.mockResolvedValue(true);
    const codes: string[] = await subject.generate('account-1', 'current-password', '123456');
    expect(codes).toHaveLength(10);
    expect(totpService.verifyCode).toHaveBeenLastCalledWith('account-1', '123456');
  });

  it('replaces the previous unused group when codes are regenerated', async () => {
    const subject = requireService();
    if (!subject) return;

    const first: string[] = await subject.generate('account-1', 'current-password');
    const second: string[] = await subject.generate('account-1', 'current-password');
    const rows = await codeRepository.findBy({ accountId: 'account-1' });

    expect(rows).toHaveLength(10);
    await expect(subject.verify('admin', first[0])).rejects.toMatchObject({
      response: { code: 'INVALID_RECOVERY_CODE' },
    });
    await expect(subject.verify('admin', second[0], undefined, preparedSessionMaterial()))
      .resolves.toEqual({ accountId: 'account-1' });
  });

  it('keeps the old group usable if any insert in a replacement group fails', async () => {
    const subject = requireService();
    if (!subject || !dataSource) return;

    const previousCodes: string[] = await subject.generate('account-1', 'current-password');
    const previousRows = await codeRepository.findBy({ accountId: 'account-1' });
    await dataSource.query(`CREATE TRIGGER fail_recovery_group_insert
      BEFORE INSERT ON recovery_codes
      BEGIN SELECT RAISE(ABORT, 'injected recovery insert failure'); END`);

    try {
      await expect(subject.generate('account-1', 'current-password')).rejects.toThrow('injected recovery insert failure');
      expect(await codeRepository.findBy({ accountId: 'account-1' })).toEqual(previousRows);
      await expect(subject.verify('admin', previousCodes[0], undefined, preparedSessionMaterial()))
        .resolves.toEqual({ accountId: 'account-1' });
    } finally {
      await dataSource.query('DROP TRIGGER IF EXISTS fail_recovery_group_insert');
    }
  });

  it('publishes one complete group when two generation requests race', async () => {
    const subject = requireService();
    if (!subject) return;

    const groups: string[][] = await Promise.all([
      subject.generate('account-1', 'current-password'),
      subject.generate('account-1', 'current-password'),
    ]);
    const rows = await codeRepository.findBy({ accountId: 'account-1' });
    const rowOwners = await Promise.all(rows.map(async ({ codeHash }) => {
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
        for (const code of groups[groupIndex]) {
          if (await argon2.verify(codeHash, code.replace(/-/g, ''))) return groupIndex;
        }
      }
      return -1;
    }));

    expect(rows).toHaveLength(10);
    expect(rowOwners.every((owner) => owner >= 0)).toBe(true);
    expect(new Set(rowOwners).size).toBe(1);
  });

  it('normalizes display separators and case, consumes once, and revokes every active account session', async () => {
    const subject = requireService();
    if (!subject) return;

    const [code] = await subject.generate('account-1', 'current-password') as string[];
    const now = Date.now();
    await accountRepository.save({
      id: 'other-account', username: 'other', passwordHash, passwordChangedAt: now, createdAt: now, isActive: 1,
    });
    await metaRepository.save({
      key: 'login_ip_198.51.100.45',
      value: JSON.stringify({ failed_count: 3, delay_until: null }),
    });
    await sessionRepository.save([
      { id: 'session-active-1', accountId: 'account-1', refreshTokenHash: 'hash-1', deviceInfo: null, createdAt: now, expiresAt: now + 1_000, revokedAt: null },
      { id: 'session-active-2', accountId: 'account-1', refreshTokenHash: 'hash-2', deviceInfo: null, createdAt: now, expiresAt: now + 1_000, revokedAt: null },
      { id: 'session-old', accountId: 'account-1', refreshTokenHash: 'hash-3', deviceInfo: null, createdAt: now, expiresAt: now + 1_000, revokedAt: now - 1 },
      { id: 'session-other', accountId: 'other-account', refreshTokenHash: 'hash-4', deviceInfo: null, createdAt: now, expiresAt: now + 1_000, revokedAt: null },
    ]);

    const recoverySession = preparedSessionMaterial();
    const result = await subject.verify('admin', code.toLowerCase().replace('-', ' '), '198.51.100.45', recoverySession);
    const consumed = (await codeRepository.findBy({ accountId: 'account-1' })).find(({ usedAt }) => usedAt !== null) ?? null;
    const sessions = await sessionRepository.find();

    expect(result).toEqual({ accountId: 'account-1' });
    expect(consumed).not.toBeNull();
    expect(consumed?.usedAt).toEqual(expect.any(Number));
    expect(sessions.find(({ id }) => id === recoverySession.id)).toMatchObject({
      accountId: recoverySession.accountId,
      refreshTokenHash: recoverySession.refreshTokenHash,
      createdAt: recoverySession.createdAt,
      expiresAt: recoverySession.expiresAt,
      revokedAt: null,
    });
    expect(sessions.find(({ id }) => id === 'session-active-1')?.revokedAt).toEqual(expect.any(Number));
    expect(sessions.find(({ id }) => id === 'session-active-2')?.revokedAt).toEqual(expect.any(Number));
    expect(sessions.find(({ id }) => id === 'session-old')?.revokedAt).toBe(now - 1);
    expect(sessions.find(({ id }) => id === 'session-other')?.revokedAt).toBeNull();
    expect(await metaRepository.findOneBy({ key: 'recovery_fail_admin' })).toBeNull();
    expect(await metaRepository.findOneBy({ key: 'login_ip_198.51.100.45' })).toBeNull();
    expect(auditService.record).toHaveBeenCalledWith({
      accountId: 'account-1', action: 'recovery.used', ip: '198.51.100.45',
    });
    await expect(subject.verify('admin', code)).rejects.toMatchObject({ response: { code: 'INVALID_RECOVERY_CODE' } });
  });

  it('rolls back recovery consumption, revocation, and IP reset if prepared session insertion fails', async () => {
    const subject = requireService();
    if (!subject || !dataSource) return;

    const [code] = await subject.generate('account-1', 'current-password') as string[];
    const now = Date.now();
    await sessionRepository.save({
      id: 'session-before-failed-recovery', accountId: 'account-1', refreshTokenHash: 'old-refresh-hash',
      deviceInfo: null, createdAt: now, expiresAt: now + 1_000, revokedAt: null,
    });
    await metaRepository.save({
      key: 'login_ip_198.51.100.90',
      value: JSON.stringify({ failed_count: 4, delay_until: null }),
    });
    const brokenSession: RecoverySessionMaterial = {
      ...preparedSessionMaterial(),
      id: 'session-insert-failure',
    };
    await dataSource.query(`CREATE TRIGGER fail_recovery_session_insert
      BEFORE INSERT ON sessions WHEN NEW.id = 'session-insert-failure'
      BEGIN SELECT RAISE(ABORT, 'injected recovery session failure'); END`);

    try {
      await expect(subject.verify('admin', code, '198.51.100.90', brokenSession))
        .rejects.toThrow('injected recovery session failure');
      expect((await codeRepository.findBy({ accountId: 'account-1' }))[0].usedAt).toBeNull();
      expect((await sessionRepository.findOneByOrFail({ id: 'session-before-failed-recovery' })).revokedAt).toBeNull();
      expect(JSON.parse((await metaRepository.findOneByOrFail({ key: 'login_ip_198.51.100.90' })).value))
        .toEqual({ failed_count: 4, delay_until: null });
      expect(auditService.record).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'recovery.used' }));
    } finally {
      await dataSource.query('DROP TRIGGER IF EXISTS fail_recovery_session_insert');
    }
  });

  it('rejects an expired code without consuming it or revoking sessions', async () => {
    const subject = requireService();
    if (!subject) return;

    const [code] = await subject.generate('account-1', 'current-password') as string[];
    const [row] = await codeRepository.findBy({ accountId: 'account-1' });
    await codeRepository.update({ id: row.id }, { expiresAt: Date.now() - 1 });
    await sessionRepository.save({
      id: 'session-active', accountId: 'account-1', refreshTokenHash: 'hash-active',
      deviceInfo: null, createdAt: Date.now(), expiresAt: Date.now() + 1_000, revokedAt: null,
    });

    await expect(subject.verify('admin', code)).rejects.toMatchObject({ response: { code: 'INVALID_RECOVERY_CODE' } });

    expect((await codeRepository.findOneByOrFail({ id: row.id })).usedAt).toBeNull();
    expect((await sessionRepository.findOneByOrFail({ id: 'session-active' })).revokedAt).toBeNull();
  });

  it('rechecks expiry after Argon2 comparison instead of accepting a code that expired while verifying', async () => {
    const subject = requireService();
    if (!subject) return;

    const [code] = await subject.generate('account-1', 'current-password') as string[];
    const [row] = await codeRepository.findBy({ accountId: 'account-1' });
    const verificationStart = Date.now();
    await codeRepository.update({ id: row.id }, { expiresAt: verificationStart + 1 });
    const originalFind = codeRepository.find.bind(codeRepository);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(verificationStart);
    const findSpy = jest.spyOn(codeRepository, 'find').mockImplementation(async (options) => {
      const candidates = await originalFind(options);
      nowSpy.mockReturnValue(verificationStart + 2);
      return candidates;
    });

    try {
      await expect(subject.verify('admin', code)).rejects.toMatchObject({
        response: { code: 'INVALID_RECOVERY_CODE' },
      });
      expect((await codeRepository.findOneByOrFail({ id: row.id })).usedAt).toBeNull();
    } finally {
      findSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  it('locks after five failures and rejects a correct sixth code until lock expiry', async () => {
    const subject = requireService();
    if (!subject) return;

    const correctCode = '0123-4567-89';
    await codeRepository.save({
      id: 'known-code', accountId: 'account-1', codeHash: await argon2.hash(correctCode.replace(/-/g, ''), {
        type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1,
      }), usedAt: null, createdAt: Date.now(), expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(subject.verify('admin', 'ZZZZ-ZZZZ-ZZ')).rejects.toMatchObject({
        response: { code: 'INVALID_RECOVERY_CODE' },
      });
    }
    const lock = await metaRepository.findOneByOrFail({ key: 'recovery_fail_admin' });
    expect(JSON.parse(lock.value)).toMatchObject({ failed_count: 0, locked_until: expect.any(Number) });
    expect(JSON.parse(lock.value).locked_until).toBeGreaterThan(Date.now());
    await expect(subject.verify('admin', correctCode)).rejects.toMatchObject({
      response: { code: 'RECOVERY_LOCKED' },
    });
  });

  it('allows at most one concurrent consumption of the same recovery code', async () => {
    const subject = requireService();
    if (!subject) return;

    const [code] = await subject.generate('account-1', 'current-password') as string[];
    const outcomes = await Promise.allSettled([
      subject.verify('admin', code, undefined, preparedSessionMaterial()),
      subject.verify('admin', code, undefined, preparedSessionMaterial()),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect((await codeRepository.findBy({ accountId: 'account-1' })).filter(({ usedAt }) => usedAt !== null)).toHaveLength(1);
    expect((await sessionRepository.findBy({ accountId: 'account-1' })).filter(({ revokedAt }) => revokedAt !== null)).toHaveLength(0);
  });

  it('linearizes distinct valid codes across independent service and SQLite transaction queues', async () => {
    const subject = requireService();
    if (!subject || !recoveryModule) return;

    const codes: string[] = await subject.generate('account-1', 'current-password');
    const otherTransactionService = new SqliteImmediateTransactionService({ get: () => dbPath } as any);
    const otherService = new recoveryModule.RecoveryService(
      codeRepository,
      accountsService,
      totpService,
      auditService as unknown as AuditService,
      otherTransactionService,
    );
    const firstSession = preparedSessionMaterial();
    const secondSession = preparedSessionMaterial();
    const outcomes = await Promise.all([
      subject.verify('admin', codes[0], undefined, firstSession),
      otherService.verify('admin', codes[1], undefined, secondSession),
    ]);
    const sessions = await sessionRepository.findBy({ accountId: 'account-1' });
    const active = sessions.filter(({ revokedAt }) => revokedAt === null);
    const used = await codeRepository.findBy({ accountId: 'account-1' });

    expect(outcomes).toEqual([{ accountId: 'account-1' }, { accountId: 'account-1' }]);
    expect(active).toHaveLength(1);
    expect([firstSession.refreshTokenHash, secondSession.refreshTokenHash]).toContain(active[0].refreshTokenHash);
    expect(used.filter(({ usedAt }) => usedAt !== null)).toHaveLength(2);
    expect(sessions.filter(({ revokedAt }) => revokedAt !== null)).toHaveLength(1);
  });
});
