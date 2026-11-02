import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AccountsService } from '../accounts/accounts.service';
import { SettingsService } from '../settings/settings.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, QueryRunner } from 'typeorm';
import { Session } from './entities/session.entity';
import { LoginChallenge } from './entities/login-challenge.entity';
import { SystemMeta } from './entities/system-meta.entity';
import { v4 as uuidv4 } from 'uuid';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
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
import { RecoveryService, type RecoverySessionMaterial } from './recovery.service';
import { reserveRecoveryIpAttempt as reservePersistentRecoveryIpAttempt, settleRecoveryIpFailure } from './recovery-ip-reservations';

const REFRESH_TOKEN_PREFIX = 'fs_rt_1';

export interface RefreshResult extends TokenPair {
  username: string;
}

export type LoginOutcome =
  | { kind: 'tokens'; tokens: TokenPair }
  | { kind: 'second_factor'; loginChallenge: string; availableMethods: string[] };

interface ParsedRefreshToken {
  sessionId: string;
  familySecret: string;
  rotationSecret: string;
}

interface PreparedRefreshToken {
  token: string;
  tokenHash: string;
  familyHash: string;
}

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

  /**
   * Reconfirm the authenticated administrator for a privileged update action.
   * This deliberately shares password-lock, IP-throttle and TOTP-step
   * admission with login, but never creates a session, token or challenge.
   */
  async verifyUpdateConfirmation(
    adminId: string,
    password: string,
    totpCode: string | undefined,
    clientIp?: string,
  ): Promise<void> {
    const security = await this.settingsService.getSecuritySettings();
    const now = Date.now();
    if (clientIp) await this.checkIpThrottle(clientIp, now);

    const account = await this.accountsService.findById(adminId);
    if (!account) {
      throw new UnauthorizedException({
        code: 'UPDATE_REAUTH_FAILED',
        message: 'Update confirmation failed',
      });
    }
    const accountState = await this.getAccountLockout(account.username);
    if (accountState.locked_until && accountState.locked_until > now) {
      const retryAfterSec = Math.ceil(
        (accountState.locked_until - now) / 1000,
      );
      throw new UnauthorizedException({
        code: 'ACCOUNT_LOCKED',
        message: `Account locked, retry after ${retryAfterSec} seconds`,
        retry_after: retryAfterSec,
      });
    }

    const passwordAccepted = await this.accountsService.validatePassword(
      account,
      password,
    );
    if (!passwordAccepted) {
      await this.recordLoginFailure(
        account.username,
        security.max_login_attempts,
        security.lockout_minutes,
        now,
      );
      if (clientIp) await this.recordIpFailure(clientIp, now);
      await this.auditService.record({
        accountId: account.id,
        action: AuditAction.UPDATE_CONFIRM_FAILED,
        resourceType: 'update',
        details: { factor: 'password' },
        ip: clientIp,
      });
      throw new UnauthorizedException({
        code: 'UPDATE_REAUTH_FAILED',
        message: 'Update confirmation failed',
      });
    }

    if (await this.totpService.hasActiveTotp(account.id)) {
      const admission = await this.reserveTotpAttempt(
        account.id,
        account.username,
        security.max_login_attempts,
        security.lockout_minutes,
        clientIp,
        now,
        totpCode ?? '',
        false,
      );
      if (admission.rejection) {
        throw new UnauthorizedException({
          code: admission.rejection.code,
          message:
            admission.rejection.code === 'ACCOUNT_LOCKED'
              ? `Account locked, retry after ${admission.rejection.retryAfterSec} seconds`
              : `Too many attempts from this IP, retry after ${admission.rejection.retryAfterSec} seconds`,
          retry_after: admission.rejection.retryAfterSec,
        });
      }
      if (!admission.factorAccepted) {
        await this.auditService.record({
          accountId: account.id,
          action: AuditAction.UPDATE_CONFIRM_FAILED,
          resourceType: 'update',
          details: { factor: 'totp' },
          ip: clientIp,
        });
        throw new UnauthorizedException({
          code: 'INVALID_TOTP',
          message: 'Invalid TOTP code',
        });
      }
      return;
    }

    await this.clearLoginFailures(account.username);
    if (clientIp) await this.clearIpFailures(clientIp);
  }

  /** Recovery login uses the shared IP throttle here and account-specific locking in RecoveryService. */
  async recoveryVerify(username: string, code: string, clientIp?: string): Promise<TokenPair & { username: string }> {
    const now = Date.now();
    const ipReservationId = clientIp ? await this.reserveRecoveryIpAttempt(clientIp, now) : undefined;
    try {
      const account = await this.accountsService.findByUsername(username);
      const prepared = account ? this.prepareRecoveryTokens(account.id, account.username) : null;
      const { accountId } = await this.recoveryService.verify(username, code, clientIp, prepared?.session, ipReservationId);
      if (!account || account.id !== accountId || !prepared) {
        throw new UnauthorizedException('Account not found');
      }

      await this.auditService.record({
        accountId: account.id,
        action: AuditAction.AUTH_LOGIN,
        details: { second_factor: 'recovery' },
        ip: clientIp,
      });
      return { ...prepared.tokens, username: account.username };
    } catch (error) {
      if (clientIp && ipReservationId) {
        try {
          await this.sqliteTransactions.run((connection) =>
            settleRecoveryIpFailure(connection, clientIp, ipReservationId, Date.now()));
        } catch {
          // The durable reservation is reclaimed as a failure when its lease expires.
        }
      }
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
    const parsed = this.parseRefreshToken(refreshToken);
    let rotatedRefreshToken: string | null = null;
    const session = await this.sqliteTransactions.run(async (connection) => {
      // Expiry must be evaluated after this queued transaction owns the write lock.
      const now = Date.now();
      const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
      let current: { id: string; account_id: string } | undefined;
      let rotated: { changes: number };

      if (parsed) {
        current = await connection.get<{ id: string; account_id: string }>(
          `SELECT id, account_id FROM sessions
           WHERE id = ? AND refresh_token_hash = ? AND refresh_family_hash = ?
             AND revoked_at IS NULL AND expires_at > ?`,
          [
            parsed.sessionId,
            tokenHash,
            this.refreshFamilyHash(parsed.sessionId, parsed.familySecret),
            now,
          ],
        );
        if (!current) return null;
        const next = this.createRefreshToken(current.id, parsed.familySecret);
        rotatedRefreshToken = next.token;
        rotated = await connection.run(
          `UPDATE sessions SET refresh_token_hash = ?, expires_at = ?
           WHERE id = ? AND account_id = ? AND refresh_token_hash = ?
             AND refresh_family_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
          [
            next.tokenHash,
            expiresAt,
            current.id,
            current.account_id,
            tokenHash,
            next.familyHash,
            now,
          ],
        );
      } else {
        current = await connection.get<{ id: string; account_id: string }>(
          `SELECT id, account_id FROM sessions
           WHERE refresh_token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
          [tokenHash, now],
        );
        if (!current) return null;
        const next = this.createRefreshToken(current.id);
        rotatedRefreshToken = next.token;
        rotated = await connection.run(
          `UPDATE sessions
           SET refresh_token_hash = ?, refresh_family_hash = ?,
               pre_family_refresh_token_hash = ?, expires_at = ?
           WHERE id = ? AND account_id = ? AND refresh_token_hash = ?
             AND revoked_at IS NULL AND expires_at > ?`,
          [
            next.tokenHash,
            next.familyHash,
            tokenHash,
            expiresAt,
            current.id,
            current.account_id,
            tokenHash,
            now,
          ],
        );
      }
      return rotated.changes === 1 ? current : null;
    });

    if (!session || !rotatedRefreshToken) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const account = await this.accountsService.findById(session.account_id);
    if (!account) {
      throw new UnauthorizedException('Account not found');
    }

    return {
      accessToken: this.createAccessToken(account.id, account.username, session.id),
      refreshToken: rotatedRefreshToken,
      expiresIn: 24 * 60 * 60,
      username: account.username,
    };
  }

  async logout(refreshToken: string, accessToken?: string): Promise<void> {
    const revokedAt = Date.now();
    let payload: JwtPayload | null = null;
    if (accessToken) {
      try {
        payload = await this.jwtService.verifyAsync<JwtPayload>(accessToken, {
          ignoreExpiration: true,
        });
      } catch {
        // A malformed access token cannot revoke by sid; a refresh cookie still can.
      }
    }

    const parsedRefresh = refreshToken ? this.parseRefreshToken(refreshToken) : null;
    const tokenHash = refreshToken && !parsedRefresh
      ? this.hashToken(refreshToken)
      : null;
    const sid = payload?.principal_type === 'admin'
      && typeof payload.sub === 'string'
      && typeof payload.sid === 'string'
      ? payload.sid
      : null;
    const accountId = sid ? payload!.sub : null;
    if (!refreshToken && !sid) return;

    // A token family keeps logout revocation stable across any number of rotations.
    // Legacy UUID cookies retain one bounded pre-family hash for upgrade compatibility.
    await this.sqliteTransactions.run(async (connection) => {
      if (parsedRefresh) {
        await connection.run(
          `UPDATE sessions SET revoked_at = ?
           WHERE id = ? AND refresh_family_hash = ? AND revoked_at IS NULL`,
          [
            revokedAt,
            parsedRefresh.sessionId,
            this.refreshFamilyHash(
              parsedRefresh.sessionId,
              parsedRefresh.familySecret,
            ),
          ],
        );
      } else if (tokenHash) {
        await connection.run(
          `UPDATE sessions SET revoked_at = ?
           WHERE revoked_at IS NULL
             AND (refresh_token_hash = ? OR pre_family_refresh_token_hash = ?)`,
          [revokedAt, tokenHash, tokenHash],
        );
      }
      if (sid) {
        await connection.run(
          `UPDATE sessions SET revoked_at = ?
           WHERE id = ? AND account_id = ? AND revoked_at IS NULL`,
          [revokedAt, sid, accountId],
        );
      }
    });
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

  /** Reserve one shared-IP recovery attempt atomically before account lookup or Argon2 work. */
  private async reserveRecoveryIpAttempt(ip: string, now: number): Promise<string> {
    const reservationId = uuidv4();
    const retryAfterSec = await this.sqliteTransactions.run((connection) =>
      reservePersistentRecoveryIpAttempt(connection, ip, reservationId, now));
    if (retryAfterSec !== null) {
      throw new UnauthorizedException({
        code: 'IP_THROTTLED',
        message: `Too many attempts from this IP, retry after ${retryAfterSec} seconds`,
        retry_after: retryAfterSec,
      });
    }
    return reservationId;
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
    issueTokens = true,
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
          if (issueTokens) {
            tokens = await this.generateTokensInImmediateTransaction(
              connection,
              accountId,
              username,
            );
          }
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

  private async generateTokensInImmediateTransaction(
    connection: SqliteTransactionConnection,
    accountId: string,
    username: string,
  ): Promise<TokenPair> {
    const sessionId = uuidv4();
    const accessToken = this.createAccessToken(accountId, username, sessionId);
    const refresh = this.createRefreshToken(sessionId);
    const now = Date.now();
    const expiresIn = 24 * 60 * 60;
    await connection.run(
      'INSERT INTO sessions (id, account_id, refresh_token_hash, refresh_family_hash, device_info, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        sessionId,
        accountId,
        refresh.tokenHash,
        refresh.familyHash,
        null,
        now,
        now + 7 * 24 * 60 * 60 * 1000,
        null,
      ],
    );
    return { accessToken, refreshToken: refresh.token, expiresIn };
  }

  private async generateTokens(accountId: string, username: string): Promise<TokenPair> {
    const sessionId = uuidv4();
    const accessToken = this.createAccessToken(accountId, username, sessionId);
    const refresh = this.createRefreshToken(sessionId);
    const expiresIn = 24 * 60 * 60;

    const session = this.sessionsRepository.create({
      id: sessionId,
      accountId,
      refreshTokenHash: refresh.tokenHash,
      refreshFamilyHash: refresh.familyHash,
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    await this.sessionsRepository.save(session);

    return { accessToken, refreshToken: refresh.token, expiresIn };
  }

  private prepareRecoveryTokens(
    accountId: string,
    username: string,
  ): { tokens: TokenPair; session: RecoverySessionMaterial } {
    const sessionId = uuidv4();
    const refresh = this.createRefreshToken(sessionId);
    const now = Date.now();
    return {
      tokens: {
        accessToken: this.createAccessToken(accountId, username, sessionId),
        refreshToken: refresh.token,
        expiresIn: 24 * 60 * 60,
      },
      session: {
        id: sessionId,
        accountId,
        refreshTokenHash: refresh.tokenHash,
        refreshFamilyHash: refresh.familyHash,
        createdAt: now,
        expiresAt: now + 7 * 24 * 60 * 60 * 1000,
      },
    };
  }

  private createAccessToken(accountId: string, username: string, sessionId: string): string {
    const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub: accountId,
      username,
      principal_type: 'admin',
      sid: sessionId,
    };
    return this.jwtService.sign(payload);
  }

  private createRefreshToken(
    sessionId: string,
    familySecret = randomBytes(32).toString('base64url'),
  ): PreparedRefreshToken {
    const rotationSecret = randomBytes(32).toString('base64url');
    const token = `${REFRESH_TOKEN_PREFIX}.${sessionId}.${familySecret}.${rotationSecret}`;
    return {
      token,
      tokenHash: this.hashToken(token),
      familyHash: this.refreshFamilyHash(sessionId, familySecret),
    };
  }

  private parseRefreshToken(token: string): ParsedRefreshToken | null {
    const match = token.match(
      /^fs_rt_1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/,
    );
    return match
      ? { sessionId: match[1], familySecret: match[2], rotationSecret: match[3] }
      : null;
  }

  private refreshFamilyHash(sessionId: string, familySecret: string): string {
    return this.hashToken(`${REFRESH_TOKEN_PREFIX}.${sessionId}.${familySecret}`);
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
