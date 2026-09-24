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

  // v1.7 高优 10：AuthService 新增 SettingsService 依赖（登录锁定），必须提供 mock
  const mockSettingsService = {
    getSecuritySettings: jest.fn().mockResolvedValue({
      totp_required: false,
      max_login_attempts: 5,
      lockout_minutes: 15,
    }),
  };

  beforeEach(async () => {
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
        { provide: SettingsService, useValue: mockSettingsService }, // v1.7 高优 10
        { provide: ApiTokensService, useValue: mockApiTokensService },
        { provide: AuditService, useValue: mockAuditService },
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

      expect(result).toEqual({ accessToken: 'admin-access-token', refreshToken: expect.any(String), expiresIn: 86400 });
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
