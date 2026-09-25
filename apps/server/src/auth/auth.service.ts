import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AccountsService } from '../accounts/accounts.service';
import { SettingsService } from '../settings/settings.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, IsNull, QueryRunner } from 'typeorm';
import { Session } from './entities/session.entity';
import { LoginChallenge } from './entities/login-challenge.entity';
import { SystemMeta } from './entities/system-meta.entity';
import { v4 as uuidv4 } from 'uuid';
import { createHash, timingSafeEqual } from 'crypto';
import * as bcrypt from 'bcrypt';
import { TokenPair, JwtPayload } from '@filestation/shared';
import { LoginDto } from './dto/login.dto';
import {
  SqliteImmediateTransactionService,
  SqliteTransactionConnection,
} from '../common/database/sqlite-immediate-transaction.service';
import { ApiTokensService } from '../api-tokens/api-tokens.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { TotpService } from './totp.service';
import { RecoveryService } from './recovery.service';

export interface RefreshResult extends TokenPair {
  username: string;
}

export type LoginOutcome =
  | { kind: 'tokens'; tokens: TokenPair }
  | { kind: 'second_factor'; loginChallenge: string; availableMethods: string[] };

@Injectable()
export class AuthService {
  private static readonly DUMMY_HASH = '$2b$10$abcdefghijklmnopqrstuu1234567890abcdefghijklmnopqrstu';

  constructor(
    private accountsService: AccountsService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private settingsService: SettingsService,
    @InjectRepository(Session)
    private sessionsRepository: Repository<Session>,
    @InjectRepository(LoginChallenge)
    private challengesRepository: Repository<LoginChallenge>,
    @InjectRepository(SystemMeta)
    private systemMetaRepository: Repository<SystemMeta>,
    private dataSource: DataSource,
    private sqliteTransactions: SqliteImmediateTransactionService,
    private apiTokensService: ApiTokensService,
    private totpService: TotpService,
    private auditService: AuditService,
    private recoveryService: RecoveryService,
  ) {}

  /** API Token 换短期 JWT（1h）；scopes 直接取自数据库记录，不信任调用方 */
  async exchangeApiToken(rawToken: string, clientIp?: string): Promise<{ accessToken: string; expiresIn: number }> {
    const token = await this.apiTokensService.validatePlaintext(rawToken);
    if (!token) throw new UnauthorizedException('Invalid or expired API token');

    const account = await this.accountsService.findById(token.accountId);
    if (!account) throw new UnauthorizedException('Account not found');

    const scopes = JSON.parse(token.scopes) as string[];
    const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub: account.id,
      username: account.username,
      principal_type: 'api_token',
      scopes,
      token_id: token.id,
    };
    const accessToken = this.jwtService.sign(payload, { expiresIn: 3600 });
    await this.apiTokensService.touchLastUsed(token.id, clientIp ?? 'unknown');
    await this.auditService.record({
      accountId: account.id,
      action: AuditAction.AUTH_API_TOKEN_EXCHANGED,
      resourceType: 'api_token',
      resourceId: token.id,
      ip: clientIp,
    });
    return { accessToken, expiresIn: 3600 };
  }

  async isInitialized(): Promise<boolean> {
    const meta = await this.systemMetaRepository.findOne({ where: { key: 'initialized_at' } });
    return !!meta;
  }

  async generateInitToken(): Promise<string> {
    const token = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '').substring(0, 8);
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    const tokenHash = createHash('sha256').update(token).digest('hex');

    await this.systemMetaRepository.save({
      key: 'init_token',
      value: JSON.stringify({ token_hash: tokenHash, expires_at: expiresAt }),
    });

    return token;
  }

  async ensureInitToken(): Promise<string | null> {
    if (await this.isInitialized()) {
      return null;
    }
    // 每次启动覆盖旧 Token（防重启后无法获取）
    return this.generateInitToken();
  }

  async initialize(username: string, password: string, initToken: string): Promise<TokenPair> {
    // 密码哈希在事务外完成（避免长时间持有写锁）
    const passwordHash = await bcrypt.hash(password, 10);
    const accountId = await this.sqliteTransactions.run(async (connection) => {
      const initMeta = await connection.get<{ value: string }>(
        `SELECT value FROM system_meta WHERE key = 'init_token'`,
      );
      if (!initMeta) throw new UnauthorizedException('No initialization token generated');

      const { token_hash: expectedTokenHash, expires_at: expiresAt } = JSON.parse(initMeta.value);
      if (Date.now() > expiresAt) throw new UnauthorizedException('Initialization token expired');

      const initTokenHash = createHash('sha256').update(initToken).digest('hex');
      const actualBuffer = Buffer.from(initTokenHash, 'hex');
      const expectedBuffer = Buffer.from(expectedTokenHash, 'hex');
      if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
        throw new UnauthorizedException('Invalid initialization token');
      }

      const initialized = await connection.get<{ initialized: number }>(
        `SELECT 1 AS initialized FROM system_meta WHERE key = 'initialized_at'`,
      );
      if (initialized) throw new BadRequestException('System already initialized');

      const now = Date.now();
      const newAccountId = uuidv4();
      await connection.run(
        'INSERT INTO admin_accounts (id, username, password_hash, password_changed_at, created_at, is_active) VALUES (?, ?, ?, ?, ?, ?)',
        [newAccountId, username, passwordHash, now, now, 1],
      );
      await connection.run(
        `INSERT INTO system_meta (key, value) VALUES ('initialized_at', ?)`, [now.toString()],
      );
      await connection.run(
        `INSERT INTO system_meta (key, value) VALUES ('first_account_id', ?)`, [newAccountId],
      );
      await connection.run(`DELETE FROM system_meta WHERE key = 'init_token'`);
      return newAccountId;
    });

    return this.generateTokens(accountId, username);
  }

  async login(loginDto: LoginDto, clientIp?: string): Promise<LoginOutcome> {
    const security = await this.settingsService.getSecuritySettings();
    const now = Date.now();

    // 1) IP 维度检查（独立于账户）
    if (clientIp) {
      try {
        await this.checkIpThrottle(clientIp, now);
      } catch (error) {
        if (error instanceof UnauthorizedException) {
          await this.recordLoginFailureAudit(loginDto.username, clientIp);
        }
        throw error;
      }
    }

    // 2) 账户维度锁定检查（固定时长，首次即配置值，不翻倍）
    const accountState = await this.getAccountLockout(loginDto.username);
    if (accountState.locked_until && accountState.locked_until > now) {
      const retryAfterSec = Math.ceil((accountState.locked_until - now) / 1000);
      await this.recordLoginFailureAudit(loginDto.username, clientIp);
      throw new UnauthorizedException({ code: 'ACCOUNT_LOCKED', message: `Account locked, retry after ${retryAfterSec} seconds`, retry_after: retryAfterSec });
    }

    const account = await this.accountsService.findByUsername(loginDto.username);
    const isValid = account
      ? await this.accountsService.validatePassword(account, loginDto.password)
      : (await bcrypt.compare(loginDto.password, AuthService.DUMMY_HASH), false);

    if (!account || !isValid) {
      await this.recordLoginFailure(loginDto.username, security.max_login_attempts, security.lockout_minutes, now);
      if (clientIp) {
        await this.recordIpFailure(clientIp, now);
      }
      await this.recordLoginFailureAudit(loginDto.username, clientIp);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (await this.totpService.hasActiveTotp(account.id)) {
      const challengeTime = Date.now();
      const loginChallenge = `ch_${uuidv4()}`;
      await this.challengesRepository.save({
        id: loginChallenge,
        accountId: account.id,
        challengeType: 'totp',
        challengeData: null,
        createdAt: challengeTime,
        expiresAt: challengeTime + 5 * 60 * 1000,
        usedAt: null,
      });
      return { kind: 'second_factor', loginChallenge, availableMethods: ['totp'] };
    }

    await this.clearLoginFailures(loginDto.username);
    if (clientIp) {
      await this.clearIpFailures(clientIp);
    }

    const tokens = await this.generateTokens(account.id, account.username);
    await this.auditService.record({ accountId: account.id, action: AuditAction.AUTH_LOGIN, ip: clientIp });
    return { kind: 'tokens', tokens };
  }

  async totpSetup(accountId: string) {
    return this.totpService.setup(accountId);
  }

  async totpConfirm(accountId: string, code: string): Promise<void> {
    await this.totpService.confirm(accountId, code);
  }

  async totpDisable(accountId: string, password: string, code: string): Promise<void> {
    await this.totpService.disable(accountId, password, code);
  }

  async recoveryGenerate(accountId: string, password: string, totpCode?: string): Promise<string[]> {
    return this.recoveryService.generate(accountId, password, totpCode);
  }

  /** Recovery login uses the shared IP throttle here and account-specific locking in RecoveryService. */
  async recoveryVerify(username: string, code: string, clientIp?: string): Promise<TokenPair & { username: string }> {
    const now = Date.now();
    if (clientIp) await this.checkIpThrottle(clientIp, now);

    try {
      const { accountId } = await this.recoveryService.verify(username, code, clientIp);
      if (clientIp) await this.clearIpFailures(clientIp);
      const account = await this.accountsService.findById(accountId);
      if (!account) throw new UnauthorizedException('Account not found');

      const tokens = await this.generateTokens(account.id, account.username);
      await this.auditService.record({
        accountId: account.id,
        action: AuditAction.AUTH_LOGIN,
        details: { second_factor: 'recovery' },
        ip: clientIp,
      });
      return { ...tokens, username: account.username };
    } catch (error) {
      if (clientIp && error instanceof UnauthorizedException) await this.recordIpFailure(clientIp, now);
      throw error;
    }
  }

  async verifyTotpLogin(
    loginChallenge: string,
    code: string,
    clientIp?: string,
  ): Promise<TokenPair & { username: string }> {
    const now = Date.now();
    if (clientIp) await this.checkIpThrottle(clientIp, now);

    const claimed = await this.challengesRepository.update(
      { id: loginChallenge, usedAt: IsNull() },
      { usedAt: now },
    );
    if (claimed.affected !== 1) {
      throw new UnauthorizedException({ code: 'INVALID_CHALLENGE', message: 'Challenge is invalid or already used' });
    }

    const challenge = await this.challengesRepository.findOne({ where: { id: loginChallenge } });
    if (!challenge || challenge.expiresAt <= now || challenge.challengeType !== 'totp') {
      throw new UnauthorizedException({ code: 'CHALLENGE_EXPIRED', message: 'Challenge has expired' });
    }

    const account = await this.accountsService.findById(challenge.accountId);
    if (!account) throw new UnauthorizedException('Account not found');
    const accountState = await this.getAccountLockout(account.username);
    if (accountState.locked_until && accountState.locked_until > now) {
      const retryAfterSec = Math.ceil((accountState.locked_until - now) / 1000);
      await this.recordLoginFailureAudit(account.username, clientIp);
      throw new UnauthorizedException({
        code: 'ACCOUNT_LOCKED',
        message: `Account locked, retry after ${retryAfterSec} seconds`,
        retry_after: retryAfterSec,
      });
    }
    const security = await this.settingsService.getSecuritySettings();
    const admission = await this.reserveTotpAttempt(
      account.id,
      account.username,
      security.max_login_attempts,
      security.lockout_minutes,
      clientIp,
      now,
      code,
    );
    const rejection = admission.rejection;
    if (rejection) {
      if (rejection.code === 'ACCOUNT_LOCKED') {
        await this.recordLoginFailureAudit(account.username, clientIp);
      }
      const message = rejection.code === 'ACCOUNT_LOCKED'
        ? `Account locked, retry after ${rejection.retryAfterSec} seconds`
        : `Too many attempts from this IP, retry after ${rejection.retryAfterSec} seconds`;
      throw new UnauthorizedException({
        code: rejection.code,
        message,
        retry_after: rejection.retryAfterSec,
      });
    }

    if (!admission.factorAccepted || !admission.tokens) {
      await this.auditService.record({
        accountId: challenge.accountId,
        action: AuditAction.AUTH_TOTP_FAILED,
        ip: clientIp,
      });
      throw new UnauthorizedException({ code: 'INVALID_TOTP', message: 'Invalid TOTP code; please log in again' });
    }

    await this.auditService.record({
      accountId: account.id,
      action: AuditAction.AUTH_LOGIN,
      details: { second_factor: 'totp' },
      ip: clientIp,
    });
    return { ...admission.tokens, username: account.username };
  }

  async refreshToken(refreshToken: string): Promise<RefreshResult> {
    const tokenHash = this.hashToken(refreshToken);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const result = await queryRunner.manager
        .createQueryBuilder()
        .update(Session)
        .set({ revokedAt: Date.now() })
        .where('refresh_token_hash = :tokenHash', { tokenHash })
        .andWhere('revoked_at IS NULL')
        .andWhere('expires_at > :now', { now: Date.now() })
        .execute();

      if (result.affected === 0) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      const session = await queryRunner.manager.findOne(Session, {
        where: { refreshTokenHash: tokenHash },
      });

      if (!session) {
        throw new UnauthorizedException('Session not found');
      }

      const account = await this.accountsService.findById(session.accountId);
      if (!account) {
        throw new UnauthorizedException('Account not found');
      }

      const tokens = await this.generateTokensInTransaction(queryRunner, account.id, account.username);
      await queryRunner.commitTransaction();
      return { ...tokens, username: account.username };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(refreshToken);
    await this.sessionsRepository.update(
      { refreshTokenHash: tokenHash },
      { revokedAt: Date.now() },
    );
  }

  // ---- 登录锁定（账户固定 + IP 独立，原子 UPSERT）----

  private async getAccountLockout(username: string): Promise<{ failed_count: number; locked_until: number | null }> {
    const meta = await this.systemMetaRepository.findOne({ where: { key: `login_lockout_${username}` } });
    if (!meta) return { failed_count: 0, locked_until: null };
    try { return JSON.parse(meta.value); } catch { return { failed_count: 0, locked_until: null }; }
  }

  private async recordLoginFailure(username: string, maxAttempts: number, lockoutMinutes: number, now: number): Promise<void> {
    const key = `login_lockout_${username}`;
    await this.sqliteTransactions.run(async (connection) => {
      const meta = await connection.get<{ value: string }>('SELECT value FROM system_meta WHERE key = ?', [key]);
      let current = { failed_count: 0, locked_until: null as number | null };
      if (meta) {
        try { current = JSON.parse(meta.value); } catch { /* reset malformed historical state */ }
      }
      // A challenge that passed its initial lockout check before a concurrent request
      // locked the account must not clear that lock when its delayed failure is recorded.
      if (current.locked_until && current.locked_until > now) {
        return;
      }
      const base = current.locked_until && current.locked_until <= now ? 0 : current.failed_count;
      const failedCount = base + 1;
      const locked_until = failedCount >= maxAttempts ? now + lockoutMinutes * 60 * 1000 : null;
      await connection.run(
        'INSERT INTO system_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [key, JSON.stringify({ failed_count: locked_until ? 0 : failedCount, locked_until })],
      );
    });
  }

  private async clearLoginFailures(username: string): Promise<void> {
    await this.systemMetaRepository.delete({ key: `login_lockout_${username}` });
  }

  private async checkIpThrottle(ip: string, now: number): Promise<void> {
    const meta = await this.systemMetaRepository.findOne({ where: { key: `login_ip_${ip}` } });
    if (!meta) return;
    let state: { failed_count: number; delay_until: number | null };
    try { state = JSON.parse(meta.value); } catch { return; }
    if (state.delay_until && state.delay_until > now) {
      const retryAfterSec = Math.ceil((state.delay_until - now) / 1000);
      throw new UnauthorizedException({ code: 'IP_THROTTLED', message: `Too many attempts from this IP, retry after ${retryAfterSec} seconds`, retry_after: retryAfterSec });
    }
  }

  /** Atomically admit a TOTP guess and reserve its account/IP failure slot. */
  private async reserveTotpAttempt(
    accountId: string,
    username: string,
    maxAttempts: number,
    lockoutMinutes: number,
    ip: string | undefined,
    now: number,
    code: string,
  ): Promise<{
    rejection: { code: 'ACCOUNT_LOCKED' | 'IP_THROTTLED'; retryAfterSec: number } | null;
    factorAccepted: boolean;
    tokens: TokenPair | null;
  }> {
    const accountKey = `login_lockout_${username}`;
    const ipKey = ip ? `login_ip_${ip}` : null;
    let rejection: { code: 'ACCOUNT_LOCKED' | 'IP_THROTTLED'; retryAfterSec: number } | null = null;
    let factorAccepted = false;
    let tokens: TokenPair | null = null;
    await this.sqliteTransactions.run(async (connection) => {
      const readState = async <T extends Record<string, unknown>>(key: string, fallback: T): Promise<T> => {
        const row = await connection.get<{ value: string }>('SELECT value FROM system_meta WHERE key = ?', [key]);
        if (!row) return fallback;
        try { return JSON.parse(row.value) as T; } catch { return fallback; }
      };
      const accountState = await readState(accountKey, { failed_count: 0, locked_until: null as number | null });
      const ipState = ipKey
        ? await readState(ipKey, { failed_count: 0, delay_until: null as number | null })
        : null;

      if (ipState?.delay_until && ipState.delay_until > now) {
        rejection = { code: 'IP_THROTTLED', retryAfterSec: Math.ceil((ipState.delay_until - now) / 1000) };
      } else if (accountState.locked_until && accountState.locked_until > now) {
        rejection = { code: 'ACCOUNT_LOCKED', retryAfterSec: Math.ceil((accountState.locked_until - now) / 1000) };
      } else {
        const base = accountState.locked_until && accountState.locked_until <= now ? 0 : accountState.failed_count;
        const failedCount = base + 1;
        const lockedUntil = failedCount >= maxAttempts ? now + lockoutMinutes * 60 * 1000 : null;
        await connection.run(
          'INSERT INTO system_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          [accountKey, JSON.stringify({ failed_count: lockedUntil ? 0 : failedCount, locked_until: lockedUntil })],
        );
        if (ipKey && ipState) {
          ipState.failed_count += 1;
          if (ipState.failed_count >= 10) {
            const delaySec = Math.floor(ipState.failed_count / 10) * 30;
            ipState.delay_until = now + delaySec * 1000;
          }
          await connection.run(
            'INSERT INTO system_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            [ipKey, JSON.stringify(ipState)],
          );
        }
        // Factor work happens only after the durable per-account/IP quota
        // reservation. A request rejected above never inspects the secret/code.
        const matchedStep = await this.totpService.matchLoginCodeInTransaction(connection, accountId, code);
        if (matchedStep) {
          factorAccepted = await this.totpService.consumeLoginStep(connection, matchedStep);
        }
        if (factorAccepted) {
          await connection.run('DELETE FROM system_meta WHERE key = ?', [accountKey]);
          if (ipKey) await connection.run('DELETE FROM system_meta WHERE key = ?', [ipKey]);
          tokens = await this.generateTokensInImmediateTransaction(connection, accountId, username);
        }
      }
    });
    return { rejection, factorAccepted, tokens };
  }

  private async recordIpFailure(ip: string, now: number): Promise<void> {
    const key = `login_ip_${ip}`;
    await this.sqliteTransactions.run(async (connection) => {
      const meta = await connection.get<{ value: string }>('SELECT value FROM system_meta WHERE key = ?', [key]);
      let state = { failed_count: 0, delay_until: null as number | null };
      if (meta) { try { state = JSON.parse(meta.value); } catch { /* reset malformed historical state */ } }
      state.failed_count += 1;
      if (state.failed_count >= 10) {
        const delaySec = Math.floor(state.failed_count / 10) * 30;
        state.delay_until = now + delaySec * 1000;
      }
      await connection.run(
        'INSERT INTO system_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [key, JSON.stringify(state)],
      );
    });
  }

  private async clearIpFailures(ip: string): Promise<void> {
    await this.systemMetaRepository.delete({ key: `login_ip_${ip}` });
  }

  private async recordLoginFailureAudit(username: string, ip?: string): Promise<void> {
    await this.auditService.record({
      accountId: null,
      action: AuditAction.AUTH_LOGIN_FAILED,
      details: { username },
      ip,
    });
  }

  private async generateTokensInTransaction(queryRunner: any, accountId: string, username: string): Promise<TokenPair> {
    const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub: accountId,
      username,
      principal_type: 'admin',
    };

    const accessToken = this.jwtService.sign(payload);
    const refreshToken = uuidv4();
    const expiresIn = 24 * 60 * 60;

    const session = queryRunner.manager.create(Session, {
      id: uuidv4(),
      accountId,
      refreshTokenHash: this.hashToken(refreshToken),
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    await queryRunner.manager.save(session);

    return { accessToken, refreshToken, expiresIn };
  }

  private async generateTokensInImmediateTransaction(
    connection: SqliteTransactionConnection,
    accountId: string,
    username: string,
  ): Promise<TokenPair> {
    const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub: accountId,
      username,
      principal_type: 'admin',
    };
    const accessToken = this.jwtService.sign(payload);
    const refreshToken = uuidv4();
    const now = Date.now();
    const expiresIn = 24 * 60 * 60;
    await connection.run(
      'INSERT INTO sessions (id, account_id, refresh_token_hash, device_info, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), accountId, this.hashToken(refreshToken), null, now, now + 7 * 24 * 60 * 60 * 1000, null],
    );
    return { accessToken, refreshToken, expiresIn };
  }

  private async generateTokens(accountId: string, username: string): Promise<TokenPair> {
    const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub: accountId,
      username,
      principal_type: 'admin',
    };

    const accessToken = this.jwtService.sign(payload);
    const refreshToken = uuidv4();
    const expiresIn = 24 * 60 * 60;

    const session = this.sessionsRepository.create({
      id: uuidv4(),
      accountId,
      refreshTokenHash: this.hashToken(refreshToken),
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    await this.sessionsRepository.save(session);

    return { accessToken, refreshToken, expiresIn };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
