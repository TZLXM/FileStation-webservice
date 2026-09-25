import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { AccountsService } from '../accounts/accounts.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Session } from './entities/session.entity';
import { LoginChallenge } from './entities/login-challenge.entity';
import { SystemMeta } from './entities/system-meta.entity';
import { SettingsService } from '../settings/settings.service'; // v1.7 高优 10
import { DataSource } from 'typeorm';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import { ApiTokensService } from '../api-tokens/api-tokens.service';
import { AuditService } from '../audit/audit.service';
import { TotpService } from './totp.service';
import { RecoveryService } from './recovery.service';
import { SqliteImmediateTransactionService } from '../common/database/sqlite-immediate-transaction.service';

describe('AuthService', () => {
  let service: AuthService;

  const mockAccountsService = {
    createAccount: jest.fn(),
    findByUsername: jest.fn(),
    findById: jest.fn(),
    validatePassword: jest.fn(),
    getAccountCount: jest.fn(),
  };

  const mockJwtService = { sign: jest.fn() };
  const mockConfigService = { get: jest.fn() };
  const mockApiTokensService = {
    validatePlaintext: jest.fn(),
    touchLastUsed: jest.fn(),
  };
  const mockAuditService = { record: jest.fn().mockResolvedValue(undefined) };
  const mockTotpService = {
    hasActiveTotp: jest.fn().mockResolvedValue(false),
    verifyCode: jest.fn(),
    matchLoginCode: jest.fn().mockResolvedValue(null),
    matchLoginCodeInTransaction: jest.fn().mockResolvedValue(null),
    consumeLoginStep: jest.fn().mockResolvedValue(false),
    setup: jest.fn(),
    confirm: jest.fn(),
    disable: jest.fn(),
  };
  const mockRecoveryService = {
    generate: jest.fn(),
    verify: jest.fn(),
  };

  const mockSessionsRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
  };

  const mockChallengesRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
  };

  const mockSystemMetaRepository = {
    findOne: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
  };

  // v1.6 修正：initialize 使用原生 SQL queryRunner.query，必须 mock 完整 QueryRunner
  const mockQueryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(),
    manager: {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
    },
  };

  const mockDataSource = {
    createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
  };

  const mockSqliteTransactions = {
    run: jest.fn(async (work: (connection: any) => Promise<unknown>) => {
      await mockQueryRunner.query('BEGIN IMMEDIATE');
      const connection = {
        get: async (sql: string, parameters: unknown[] = []) => {
          const rows = await mockQueryRunner.query(sql, parameters);
          return Array.isArray(rows) ? rows[0] : rows;
        },
        all: async (sql: string, parameters: unknown[] = []) => mockQueryRunner.query(sql, parameters),
        run: async (sql: string, parameters: unknown[] = []) => {
          const result = await mockQueryRunner.query(sql, parameters, true);
          return {
            changes: Number(result?.changes ?? result?.affected ?? 0),
            lastID: Number(result?.lastID ?? 0),
          };
        },
      };
      try {
        const result = await work(connection);
        await mockQueryRunner.query('COMMIT');
        return result;
      } catch (error) {
        await mockQueryRunner.query('ROLLBACK');
        throw error;
      }
    }),
  };

  // v1.7 高优 10：AuthService 新增 SettingsService 依赖（登录锁定），必须提供 mock
  const mockSettingsService = {
    getSecuritySettings: jest.fn().mockResolvedValue({
      totp_required: false,
      max_login_attempts: 5,
      lockout_minutes: 15,
    }),
  };

  beforeEach(async () => {
    mockAccountsService.findByUsername.mockReset().mockResolvedValue(null);
    mockTotpService.hasActiveTotp.mockResolvedValue(false);
    mockTotpService.matchLoginCodeInTransaction.mockResolvedValue(null);
    mockTotpService.consumeLoginStep.mockResolvedValue(false);
    mockRecoveryService.generate.mockReset().mockResolvedValue(['mock-recovery-code']);
    mockRecoveryService.verify.mockReset().mockResolvedValue({ accountId: 'account-1' });
    mockQueryRunner.query.mockReset().mockResolvedValue([]);
    mockQueryRunner.manager.findOne.mockReset().mockResolvedValue(null);
    mockQueryRunner.manager.save.mockReset().mockResolvedValue(undefined);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: AccountsService, useValue: mockAccountsService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: getRepositoryToken(Session), useValue: mockSessionsRepository },
        { provide: getRepositoryToken(LoginChallenge), useValue: mockChallengesRepository },
        { provide: getRepositoryToken(SystemMeta), useValue: mockSystemMetaRepository },
        { provide: DataSource, useValue: mockDataSource },
        { provide: SqliteImmediateTransactionService, useValue: mockSqliteTransactions },
        { provide: SettingsService, useValue: mockSettingsService }, // v1.7 高优 10
        { provide: ApiTokensService, useValue: mockApiTokensService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: TotpService, useValue: mockTotpService },
        { provide: RecoveryService, useValue: mockRecoveryService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('isInitialized', () => {
    it('should return true when initialized', async () => {
      mockSystemMetaRepository.findOne.mockResolvedValue({ key: 'initialized_at', value: '123' });
      expect(await service.isInitialized()).toBe(true);
    });

    it('should return false when not initialized', async () => {
      mockSystemMetaRepository.findOne.mockResolvedValue(null);
      expect(await service.isInitialized()).toBe(false);
    });
  });

  describe('initialize', () => {
    it('should throw UnauthorizedException when no init token generated', async () => {
      // BEGIN IMMEDIATE 后第一次 query 返回空（无 init_token 行）
      mockQueryRunner.query.mockImplementation(async (sql: string) => {
        if (sql === 'BEGIN IMMEDIATE' || sql === 'ROLLBACK') return [];
        if (typeof sql === 'string' && sql.includes("key = 'init_token'")) return [];
        return [];
      });

      await expect(service.initialize('user', 'password123', 'token'))
        .rejects.toThrow(UnauthorizedException);
      expect(mockQueryRunner.query).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    });

    it('should throw UnauthorizedException when init token expired', async () => {
      const expiredValue = JSON.stringify({
        token_hash: createHash('sha256').update('token').digest('hex'),
        expires_at: Date.now() - 1000,
      });
      mockQueryRunner.query.mockImplementation(async (sql: string) => {
        if (sql === 'BEGIN IMMEDIATE' || sql === 'ROLLBACK') return [];
        if (typeof sql === 'string' && sql.includes("key = 'init_token'")) return [{ value: expiredValue }];
        return [];
      });

      await expect(service.initialize('user', 'password123', 'token'))
        .rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when init token mismatch (timingSafeEqual)', async () => {
      const value = JSON.stringify({
        token_hash: createHash('sha256').update('correct-token').digest('hex'),
        expires_at: Date.now() + 60000,
      });
      mockQueryRunner.query.mockImplementation(async (sql: string) => {
        if (sql === 'BEGIN IMMEDIATE' || sql === 'ROLLBACK') return [];
        if (typeof sql === 'string' && sql.includes("key = 'init_token'")) return [{ value }];
        return [];
      });

      await expect(service.initialize('user', 'password123', 'wrong-token'))
        .rejects.toThrow(UnauthorizedException);
    });

    it('should throw BadRequestException when already initialized', async () => {
      const token = 'valid-token';
      const value = JSON.stringify({
        token_hash: createHash('sha256').update(token).digest('hex'),
        expires_at: Date.now() + 60000,
      });
      mockQueryRunner.query.mockImplementation(async (sql: string) => {
        if (sql === 'BEGIN IMMEDIATE' || sql === 'ROLLBACK') return [];
        if (typeof sql === 'string' && sql.includes("key = 'init_token'")) return [{ value }];
        if (typeof sql === 'string' && sql.includes("key = 'initialized_at'")) return [{ '1': 1 }];
        return [];
      });

      await expect(service.initialize('user', 'password123', token))
        .rejects.toThrow(BadRequestException);
    });

    it('should commit and return tokens on success', async () => {
      const token = 'valid-token';
      const value = JSON.stringify({
        token_hash: createHash('sha256').update(token).digest('hex'),
        expires_at: Date.now() + 60000,
      });
      mockQueryRunner.query.mockImplementation(async (sql: string) => {
        if (sql === 'BEGIN IMMEDIATE' || sql === 'COMMIT') return [];
        if (typeof sql === 'string' && sql.includes("key = 'init_token'")) return [{ value }];
        if (typeof sql === 'string' && sql.includes("key = 'initialized_at'")) return []; // 未初始化
        return [];
      });
      mockJwtService.sign.mockReturnValue('access-token');
      mockSessionsRepository.create.mockImplementation((x) => x);
      mockSessionsRepository.save.mockResolvedValue({});

      const result = await service.initialize('user', 'password123', token);
      expect(result.accessToken).toBe('access-token');
      expect(mockQueryRunner.query).toHaveBeenCalledWith('COMMIT');
    });
  });

  describe('refreshToken', () => {
    it('should include username in result', async () => {
      // update builder mock（原子抢占）
      const executeMock = jest.fn().mockResolvedValue({ affected: 1 });
      const builderMock = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: executeMock,
      };
      mockQueryRunner.manager.createQueryBuilder.mockReturnValue(builderMock);
      mockQueryRunner.manager.findOne.mockResolvedValue({ accountId: 'acc-1' });
      mockAccountsService.findById.mockResolvedValue({ id: 'acc-1', username: 'admin' });
      mockQueryRunner.manager.create.mockImplementation((_e, x) => x);
      mockQueryRunner.manager.save.mockResolvedValue({});
      mockJwtService.sign.mockReturnValue('new-access');

      const result = await service.refreshToken('refresh-token');
      expect(result.username).toBe('admin');
      expect(result.accessToken).toBe('new-access');
    });
  });

  describe('login audit events', () => {
    it('records a successful login without recording the password', async () => {
      const password = 'correct-password';
      mockSettingsService.getSecuritySettings.mockResolvedValue({
        totp_required: false,
        max_login_attempts: 5,
        lockout_minutes: 15,
      });
      mockSystemMetaRepository.findOne.mockResolvedValue(null);
      mockSystemMetaRepository.delete.mockResolvedValue(undefined);
      mockAccountsService.findByUsername.mockResolvedValue({ id: 'account-1', username: 'admin' });
      mockAccountsService.validatePassword.mockResolvedValue(true);
      mockSessionsRepository.create.mockImplementation((session) => session);
      mockSessionsRepository.save.mockResolvedValue(undefined);
      mockJwtService.sign.mockReturnValue('admin-access-token');

      const result = await service.login({ username: 'admin', password }, '198.51.100.45');

      expect(result).toEqual({
        kind: 'tokens',
        tokens: { accessToken: 'admin-access-token', refreshToken: expect.any(String), expiresIn: 86400 },
      });
      expect(mockAuditService.record).toHaveBeenCalledWith({
        accountId: 'account-1',
        action: 'auth.login',
        ip: '198.51.100.45',
      });
      expect(JSON.stringify(mockAuditService.record.mock.calls[0][0])).not.toContain(password);
    });

    it('records invalid credentials while preserving the unauthorized outcome', async () => {
      const password = 'incorrect-password';
      mockSettingsService.getSecuritySettings.mockResolvedValue({
        totp_required: false,
        max_login_attempts: 5,
        lockout_minutes: 15,
      });
      mockSystemMetaRepository.findOne.mockResolvedValue(null);
      mockSystemMetaRepository.save.mockResolvedValue(undefined);
      mockAccountsService.findByUsername.mockResolvedValue({ id: 'account-1', username: 'admin' });
      mockAccountsService.validatePassword.mockResolvedValue(false);

      await expect(service.login({ username: 'admin', password }, '198.51.100.45')).rejects.toThrow(UnauthorizedException);

      expect(mockAuditService.record).toHaveBeenCalledWith({
        accountId: null,
        action: 'auth.login_failed',
        details: { username: 'admin' },
        ip: '198.51.100.45',
      });
      expect(JSON.stringify(mockAuditService.record.mock.calls[0][0])).not.toContain(password);
      expect(mockSessionsRepository.save).not.toHaveBeenCalled();
    });

    it('records a login rejected by the IP throttle', async () => {
      mockSettingsService.getSecuritySettings.mockResolvedValue({
        totp_required: false,
        max_login_attempts: 5,
        lockout_minutes: 15,
      });
      mockSystemMetaRepository.findOne.mockResolvedValue({
        key: 'login_ip_198.51.100.45',
        value: JSON.stringify({ failed_count: 10, delay_until: Date.now() + 60_000 }),
      });

      await expect(service.login({ username: 'admin', password: 'incorrect-password' }, '198.51.100.45'))
        .rejects.toThrow(UnauthorizedException);

      expect(mockAuditService.record).toHaveBeenCalledWith({
        accountId: null,
        action: 'auth.login_failed',
        details: { username: 'admin' },
        ip: '198.51.100.45',
      });
      expect(mockAccountsService.findByUsername).not.toHaveBeenCalled();
    });

    it('records a login rejected because the account is locked', async () => {
      mockSettingsService.getSecuritySettings.mockResolvedValue({
        totp_required: false,
        max_login_attempts: 5,
        lockout_minutes: 15,
      });
      mockSystemMetaRepository.findOne.mockResolvedValue({
        key: 'login_lockout_admin',
        value: JSON.stringify({ failed_count: 0, locked_until: Date.now() + 60_000 }),
      });

      await expect(service.login({ username: 'admin', password: 'incorrect-password' }))
        .rejects.toThrow(UnauthorizedException);

      expect(mockAuditService.record).toHaveBeenCalledWith({
        accountId: null,
        action: 'auth.login_failed',
        details: { username: 'admin' },
      });
      expect(mockAccountsService.findByUsername).not.toHaveBeenCalled();
    });
  });

  describe('recovery-code authentication entry points', () => {
    const getMethod = (name: string) => {
      const method = (service as any)[name];
      expect(typeof method).toBe('function');
      return typeof method === 'function' ? method.bind(service) : null;
    };

    it('delegates generation with the authenticated account, password, and optional TOTP code', async () => {
      const generate = getMethod('recoveryGenerate');
      if (!generate) return;

      await generate('account-1', 'current-password', '654321');

      expect(mockRecoveryService.generate).toHaveBeenCalledWith('account-1', 'current-password', '654321');
    });

    it('atomically rejects a throttled IP before asking RecoveryService to inspect a submitted code', async () => {
      const verify = getMethod('recoveryVerify');
      if (!verify) return;
      const ip = '198.51.100.45';
      mockQueryRunner.query.mockImplementation(async (sql: string, parameters?: unknown[]) => {
        if (sql.startsWith('SELECT value FROM system_meta') && parameters?.[0] === `login_ip_${ip}`) {
          return [{ value: JSON.stringify({ failed_count: 10, delay_until: Date.now() + 60_000 }) }];
        }
        return [];
      });

      await expect(verify('admin', 'recovery-test-input', ip)).rejects.toThrow(UnauthorizedException);

      expect(mockRecoveryService.verify).not.toHaveBeenCalled();
      expect(mockQueryRunner.query).toHaveBeenCalledWith('BEGIN IMMEDIATE');
      expect(mockQueryRunner.query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
      expect(mockSystemMetaRepository.delete).not.toHaveBeenCalled();
    });

    it('retains the atomically reserved IP slot when recovery verification rejects the code', async () => {
      const verify = getMethod('recoveryVerify');
      if (!verify) return;
      const ip = '198.51.100.46';
      mockRecoveryService.verify.mockRejectedValue(new UnauthorizedException({ code: 'INVALID_RECOVERY_CODE' }));

      await expect(verify('admin', 'recovery-test-input', ip)).rejects.toThrow(UnauthorizedException);

      expect(mockRecoveryService.verify).toHaveBeenCalledWith('admin', 'recovery-test-input', ip, undefined);
      const ipUpserts = mockQueryRunner.query.mock.calls.filter(([sql, params]) =>
        typeof sql === 'string' && sql.startsWith('INSERT INTO system_meta') && params?.[0] === `login_ip_${ip}`,
      );
      expect(ipUpserts).toHaveLength(1);
    });

    it('prepares the refresh hash and session material before recovery and returns its token only on success', async () => {
      const verify = getMethod('recoveryVerify');
      if (!verify) return;
      const ip = '198.51.100.47';
      mockAccountsService.findByUsername.mockResolvedValue({ id: 'account-1', username: 'admin' });
      mockJwtService.sign.mockReturnValue('admin-access-token');

      const result = await verify('admin', 'valid-test-input', ip);

      expect(result).toEqual({
        accessToken: 'admin-access-token',
        refreshToken: expect.any(String),
        expiresIn: 86400,
        username: 'admin',
      });
      const [, , , session] = mockRecoveryService.verify.mock.calls[0];
      expect(session).toMatchObject({ accountId: 'account-1', id: expect.any(String) });
      expect(session.refreshTokenHash).toBe(createHash('sha256').update(result.refreshToken).digest('hex'));
      expect(session.expiresAt - session.createdAt).toBe(7 * 24 * 60 * 60 * 1000);
      expect(mockSessionsRepository.save).not.toHaveBeenCalled();
      const ipUpserts = mockQueryRunner.query.mock.calls.filter(([sql, params]) =>
        typeof sql === 'string' && sql.startsWith('INSERT INTO system_meta') && params?.[0] === `login_ip_${ip}`,
      );
      expect(ipUpserts).toHaveLength(1);
    });
  });

  describe('TOTP login challenge', () => {
    const getVerifier = () => {
      const verifier = (service as any).verifyTotpLogin;
      expect(typeof verifier).toBe('function');
      return typeof verifier === 'function' ? verifier.bind(service) : null;
    };

    it('creates a five-minute one-time challenge after a valid password and withholds tokens', async () => {
      mockSettingsService.getSecuritySettings.mockResolvedValue({
        totp_required: false,
        max_login_attempts: 5,
        lockout_minutes: 15,
      });
      mockSystemMetaRepository.findOne.mockResolvedValue(null);
      mockSystemMetaRepository.delete.mockResolvedValue(undefined);
      mockChallengesRepository.save.mockResolvedValue(undefined);
      mockAccountsService.findByUsername.mockResolvedValue({ id: 'account-1', username: 'admin' });
      mockAccountsService.validatePassword.mockResolvedValue(true);
      mockTotpService.hasActiveTotp.mockResolvedValue(true);

      const result = await service.login({ username: 'admin', password: 'valid-password' }, '198.51.100.45');
      expect(mockChallengesRepository.save).toHaveBeenCalled();
      if (mockChallengesRepository.save.mock.calls.length === 0) return;
      const [challenge] = mockChallengesRepository.save.mock.calls[0];

      expect(result).toMatchObject({ kind: 'second_factor', availableMethods: ['totp'] });
      if (result.kind !== 'second_factor') return;
      expect(result.loginChallenge).toMatch(/^ch_/);
      expect(challenge).toMatchObject({
        id: result.loginChallenge,
        accountId: 'account-1',
        challengeType: 'totp',
        challengeData: null,
        usedAt: null,
      });
      expect(challenge.expiresAt - challenge.createdAt).toBe(5 * 60 * 1000);
      expect(mockSessionsRepository.save).not.toHaveBeenCalled();
      expect(mockJwtService.sign).not.toHaveBeenCalled();
      expect(mockAuditService.record).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.login' }));
    });

    it('retains TOTP failures across new challenges and blocks outstanding challenges during account lockout', async () => {
      const verifier = getVerifier();
      if (!verifier) return;
      const firstIp = '198.51.100.51';
      const otherIp = '198.51.100.52';
      const meta = new Map<string, Record<string, any>>();
      const challenges = new Map<string, any>();
      mockSettingsService.getSecuritySettings.mockResolvedValue({
        max_login_attempts: 2,
        lockout_minutes: 15,
      });
      mockSystemMetaRepository.findOne.mockImplementation(async ({ where: { key } }: { where: { key: string } }) => {
        const state = meta.get(key);
        return state ? { key, value: JSON.stringify(state) } : null;
      });
      mockQueryRunner.query.mockImplementation(async (sql: string, parameters: unknown[] = []) => {
        if (sql.startsWith('SELECT value FROM system_meta')) {
          const key = String(parameters[0]);
          const state = meta.get(key);
          return state ? [{ value: JSON.stringify(state) }] : [];
        }
        if (sql.startsWith('INSERT INTO system_meta')) {
          meta.set(String(parameters[0]), JSON.parse(String(parameters[1])));
        }
        return [];
      });
      mockSystemMetaRepository.delete.mockImplementation(async ({ key }: { key: string }) => {
        const affected = meta.delete(key) ? 1 : 0;
        return { affected };
      });
      mockChallengesRepository.save.mockImplementation(async (challenge: any) => {
        challenges.set(challenge.id, { ...challenge });
        return challenge;
      });
      mockChallengesRepository.update.mockImplementation(async ({ id }: { id: string }, patch: any) => {
        const challenge = challenges.get(id);
        if (!challenge || challenge.usedAt !== null) return { affected: 0 };
        Object.assign(challenge, patch);
        return { affected: 1 };
      });
      mockChallengesRepository.findOne.mockImplementation(async ({ where }: { where: { id: string } }) => challenges.get(where.id) ?? null);
      mockAccountsService.findByUsername.mockResolvedValue({ id: 'account-1', username: 'admin' });
      mockAccountsService.findById.mockResolvedValue({ id: 'account-1', username: 'admin' });
      mockAccountsService.validatePassword.mockResolvedValue(true);
      mockTotpService.hasActiveTotp.mockResolvedValue(true);
      mockTotpService.matchLoginCodeInTransaction.mockResolvedValue(null);

      const first = await service.login({ username: 'admin', password: 'valid-password' }, firstIp);
      if (first.kind !== 'second_factor') throw new Error('Expected a second-factor challenge');
      await expect(verifier(first.loginChallenge, '000000', firstIp)).rejects.toThrow(UnauthorizedException);
      expect(meta.get('login_lockout_admin')?.failed_count).toBe(1);

      const second = await service.login({ username: 'admin', password: 'valid-password' }, firstIp);
      const third = await service.login({ username: 'admin', password: 'valid-password' }, firstIp);
      if (second.kind !== 'second_factor' || third.kind !== 'second_factor') {
        throw new Error('Expected second-factor challenges');
      }
      expect(meta.get('login_lockout_admin')?.failed_count).toBe(1);
      expect(meta.get(`login_ip_${firstIp}`)?.failed_count).toBe(1);

      await expect(verifier(second.loginChallenge, '000000', firstIp)).rejects.toThrow(UnauthorizedException);
      expect(mockTotpService.matchLoginCodeInTransaction).toHaveBeenCalledTimes(2);
      expect(meta.get('login_lockout_admin')).toEqual({ failed_count: 0, locked_until: expect.any(Number) });
      const checksBeforeLockedChallenge = mockTotpService.matchLoginCodeInTransaction.mock.calls.length;

      await expect(verifier(third.loginChallenge, '000000', otherIp)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ACCOUNT_LOCKED' }),
      });
      expect(mockTotpService.matchLoginCodeInTransaction).toHaveBeenCalledTimes(checksBeforeLockedChallenge);
      expect(mockSessionsRepository.save).not.toHaveBeenCalled();
    });

    it('consumes an incorrect code, counts both account and IP failures, and keeps audit details redacted', async () => {
      const verifier = getVerifier();
      if (!verifier) return;
      const ip = '198.51.100.46';
      const challenge = {
        id: 'ch-failed', accountId: 'account-1', challengeType: 'totp', expiresAt: Date.now() + 60_000, usedAt: null,
      };
      mockSystemMetaRepository.findOne.mockResolvedValue(null);
      mockSystemMetaRepository.save.mockResolvedValue(undefined);
      mockSettingsService.getSecuritySettings.mockResolvedValue({ max_login_attempts: 5, lockout_minutes: 15 });
      mockChallengesRepository.update.mockResolvedValue({ affected: 1 });
      mockChallengesRepository.findOne.mockResolvedValue(challenge);
      mockAccountsService.findById.mockResolvedValue({ id: 'account-1', username: 'admin' });
      mockTotpService.matchLoginCodeInTransaction.mockResolvedValue(null);

      await expect(verifier('ch-failed', '123456', ip)).rejects.toThrow(UnauthorizedException);

      expect(mockChallengesRepository.update).toHaveBeenCalledWith(
        { id: 'ch-failed', usedAt: expect.objectContaining({ _type: 'isNull' }) },
        { usedAt: expect.any(Number) },
      );
      const upserts = mockQueryRunner.query.mock.calls
        .filter(([sql]) => typeof sql === 'string' && sql.startsWith('INSERT INTO system_meta'))
        .map(([_sql, parameters]) => ({
          key: parameters[0],
          value: JSON.parse(String(parameters[1])),
        }));
      expect(upserts.map(({ key }) => key)).toEqual(
        expect.arrayContaining(['login_lockout_admin', `login_ip_${ip}`]),
      );
      expect(mockAuditService.record).toHaveBeenCalledWith({
        accountId: 'account-1',
        action: 'auth.totp_failed',
        ip,
      });
      const savedStates = upserts.map(({ value }) => value);
      expect(savedStates).toEqual(expect.arrayContaining([
        expect.objectContaining({ failed_count: 1, locked_until: null }),
        expect.objectContaining({ failed_count: 1, delay_until: null }),
      ]));
      expect(mockSessionsRepository.save).not.toHaveBeenCalled();
      expect(JSON.stringify(mockAuditService.record.mock.calls)).not.toContain('123456');
      expect(JSON.stringify(mockAuditService.record.mock.calls)).not.toContain('ch-failed');
    });

    it('rejects a replayed or unknown challenge without looking up the factor or issuing tokens', async () => {
      const verifier = getVerifier();
      if (!verifier) return;
      mockSystemMetaRepository.findOne.mockResolvedValue(null);
      mockChallengesRepository.update.mockResolvedValue({ affected: 0 });

      await expect(verifier('ch-used', '123456', '198.51.100.47')).rejects.toThrow(UnauthorizedException);

      expect(mockChallengesRepository.findOne).not.toHaveBeenCalled();
      expect(mockTotpService.matchLoginCodeInTransaction).not.toHaveBeenCalled();
      expect(mockSessionsRepository.save).not.toHaveBeenCalled();
      expect(mockJwtService.sign).not.toHaveBeenCalled();
    });

    it.each([
      ['expired', { id: 'ch-expired', accountId: 'account-1', challengeType: 'totp', expiresAt: Date.now() - 1, usedAt: null }],
      ['wrong type', { id: 'ch-wrong-type', accountId: 'account-1', challengeType: 'webauthn', expiresAt: Date.now() + 60_000, usedAt: null }],
    ])('does not issue tokens for an %s challenge', async (_label, challenge) => {
      const verifier = getVerifier();
      if (!verifier) return;
      mockSystemMetaRepository.findOne.mockResolvedValue(null);
      mockChallengesRepository.update.mockResolvedValue({ affected: 1 });
      mockChallengesRepository.findOne.mockResolvedValue(challenge);

      await expect(verifier(challenge.id, '123456', '198.51.100.48')).rejects.toThrow(UnauthorizedException);

      expect(mockTotpService.matchLoginCodeInTransaction).not.toHaveBeenCalled();
      expect(mockSessionsRepository.save).not.toHaveBeenCalled();
      expect(mockJwtService.sign).not.toHaveBeenCalled();
    });

    it('issues tokens only after the active account challenge verifies and clears both failure counters', async () => {
      const verifier = getVerifier();
      if (!verifier) return;
      const ip = '198.51.100.49';
      mockSystemMetaRepository.findOne.mockResolvedValue(null);
      mockSystemMetaRepository.delete.mockResolvedValue(undefined);
      mockChallengesRepository.update.mockResolvedValue({ affected: 1 });
      mockChallengesRepository.findOne.mockResolvedValue({
        id: 'ch-valid', accountId: 'account-1', challengeType: 'totp', expiresAt: Date.now() + 60_000, usedAt: null,
      });
      mockAccountsService.findById.mockResolvedValue({ id: 'account-1', username: 'admin' });
      mockTotpService.matchLoginCodeInTransaction.mockResolvedValue({ authenticatorId: 'auth-1', timestamp: 1_800_000_000_000 });
      mockTotpService.consumeLoginStep.mockResolvedValue(true);
      mockJwtService.sign.mockReturnValue('access');

      const result = await verifier('ch-valid', '654321', ip);

      expect(result).toEqual({ accessToken: 'access', refreshToken: expect.any(String), expiresIn: 86400, username: 'admin' });
      const clearedKeys = mockQueryRunner.query.mock.calls
        .filter(([sql]) => typeof sql === 'string' && sql.startsWith('DELETE FROM system_meta'))
        .map(([_sql, parameters]) => parameters[0]);
      expect(clearedKeys).toEqual(expect.arrayContaining(['login_lockout_admin', `login_ip_${ip}`]));
      expect(mockAuditService.record).toHaveBeenCalledWith({
        accountId: 'account-1', action: 'auth.login', details: { second_factor: 'totp' }, ip,
      });
      expect(mockQueryRunner.query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.startsWith('INSERT INTO sessions'))).toBe(true);
      expect(JSON.stringify(mockAuditService.record.mock.calls)).not.toContain('654321');
      expect(JSON.stringify(mockAuditService.record.mock.calls)).not.toContain('ch-valid');
    });

    it('checks IP throttling before consuming a challenge', async () => {
      const verifier = getVerifier();
      if (!verifier) return;
      mockSystemMetaRepository.findOne.mockResolvedValue({
        key: 'login_ip_198.51.100.50',
        value: JSON.stringify({ failed_count: 10, delay_until: Date.now() + 60_000 }),
      });

      await expect(verifier('ch-throttled', '123456', '198.51.100.50')).rejects.toThrow(UnauthorizedException);

      expect(mockChallengesRepository.update).not.toHaveBeenCalled();
      expect(mockTotpService.matchLoginCodeInTransaction).not.toHaveBeenCalled();
      expect(mockSessionsRepository.save).not.toHaveBeenCalled();
    });

    it('does not evaluate a TOTP code when atomic admission rejects the IP', async () => {
      const verifier = getVerifier();
      if (!verifier) return;
      const ip = '198.51.100.60';
      mockSystemMetaRepository.findOne.mockResolvedValue(null);
      mockChallengesRepository.update.mockResolvedValue({ affected: 1 });
      mockChallengesRepository.findOne.mockResolvedValue({
        id: 'ch-admission-rejected', accountId: 'account-1', challengeType: 'totp',
        expiresAt: Date.now() + 60_000, usedAt: null,
      });
      mockAccountsService.findById.mockResolvedValue({ id: 'account-1', username: 'admin' });
      mockQueryRunner.query.mockImplementation(async (sql: string, parameters: unknown[] = []) => {
        if (sql === 'BEGIN IMMEDIATE' || sql === 'COMMIT') return [];
        if (sql.startsWith('SELECT value FROM system_meta')) {
          if (parameters[0] === `login_ip_${ip}`) {
            return [{ value: JSON.stringify({ failed_count: 10, delay_until: Date.now() + 60_000 }) }];
          }
        }
        return [];
      });

      await expect(verifier('ch-admission-rejected', '000001', ip)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'IP_THROTTLED' }),
      });

      expect(mockTotpService.matchLoginCodeInTransaction).not.toHaveBeenCalled();
    });
  });

  describe('API token exchange audit event', () => {
    it('records the token id on a successful exchange without recording the plaintext token', async () => {
      const plaintextToken = 'fs_secret_api_token';
      mockApiTokensService.validatePlaintext.mockResolvedValue({
        id: 'token-1',
        accountId: 'account-1',
        scopes: '["files:read"]',
      });
      mockAccountsService.findById.mockResolvedValue({ id: 'account-1', username: 'admin' });
      mockJwtService.sign.mockReturnValue('short-lived-jwt');
      mockApiTokensService.touchLastUsed.mockResolvedValue(undefined);

      const result = await service.exchangeApiToken(plaintextToken, '203.0.113.9');

      expect(result).toEqual({ accessToken: 'short-lived-jwt', expiresIn: 3600 });
      expect(mockAuditService.record).toHaveBeenCalledWith({
        accountId: 'account-1',
        action: 'auth.api_token_exchanged',
        resourceType: 'api_token',
        resourceId: 'token-1',
        ip: '203.0.113.9',
      });
      expect(JSON.stringify(mockAuditService.record.mock.calls[0][0])).not.toContain(plaintextToken);
    });
  });
});
