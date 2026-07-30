import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AccountsService } from '../accounts/accounts.service';
import { SettingsService } from '../settings/settings.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Session } from './entities/session.entity';
import { LoginChallenge } from './entities/login-challenge.entity';
import { SystemMeta } from './entities/system-meta.entity';
import { v4 as uuidv4 } from 'uuid';
import { createHash, timingSafeEqual } from 'crypto';
import * as bcrypt from 'bcrypt';
import { TokenPair, JwtPayload } from '@filestation/shared';
import { LoginDto } from './dto/login.dto';

export interface RefreshResult extends TokenPair {
  username: string;
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
    private dataSource: DataSource,
  ) {}

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

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      await queryRunner.query('BEGIN IMMEDIATE');

      const metaResult = await queryRunner.query(
        `SELECT value FROM system_meta WHERE key = 'init_token'`,
      );
      if (metaResult.length === 0) {
        throw new UnauthorizedException('No initialization token generated');
      }

      const { token_hash: expectedTokenHash, expires_at: expiresAt } = JSON.parse(metaResult[0].value);

      if (Date.now() > expiresAt) {
        throw new UnauthorizedException('Initialization token expired');
      }

      const initTokenHash = createHash('sha256').update(initToken).digest('hex');
      const actualBuffer = Buffer.from(initTokenHash, 'hex');
      const expectedBuffer = Buffer.from(expectedTokenHash, 'hex');

      if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
        throw new UnauthorizedException('Invalid initialization token');
      }

      const initializedResult = await queryRunner.query(
        `SELECT 1 FROM system_meta WHERE key = 'initialized_at'`,
      );
      if (initializedResult.length > 0) {
        throw new BadRequestException('System already initialized');
      }

      const now = Date.now();
      const accountId = uuidv4();
      await queryRunner.query(
        `INSERT INTO admin_accounts (id, username, password_hash, password_changed_at, created_at, is_active) VALUES (?, ?, ?, ?, ?, ?)`,
        [accountId, username, passwordHash, now, now, 1],
      );

      await queryRunner.query(
        `INSERT INTO system_meta (key, value) VALUES ('initialized_at', ?)`,
        [now.toString()],
      );
      await queryRunner.query(
        `INSERT INTO system_meta (key, value) VALUES ('first_account_id', ?)`,
        [accountId],
      );

      await queryRunner.query(
        `DELETE FROM system_meta WHERE key = 'init_token'`,
      );

      await queryRunner.query('COMMIT');

      return this.generateTokens(accountId, username);
    } catch (error) {
      await queryRunner.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async login(loginDto: LoginDto, clientIp?: string): Promise<TokenPair> {
    const security = await this.settingsService.getSecuritySettings();
    const now = Date.now();

    // 1) IP 维度检查（独立于账户）
    if (clientIp) {
      await this.checkIpThrottle(clientIp, now);
    }

    // 2) 账户维度锁定检查（固定时长，首次即配置值，不翻倍）
    const accountState = await this.getAccountLockout(loginDto.username);
    if (accountState.locked_until && accountState.locked_until > now) {
      const retryAfterSec = Math.ceil((accountState.locked_until - now) / 1000);
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
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.clearLoginFailures(loginDto.username);
    if (clientIp) {
      await this.clearIpFailures(clientIp);
    }

    return this.generateTokens(account.id, account.username);
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
    const current = await this.getAccountLockout(username);
    const base = current.locked_until && current.locked_until <= now ? 0 : current.failed_count;
    const failedCount = base + 1;
    const locked_until = failedCount >= maxAttempts ? now + lockoutMinutes * 60 * 1000 : null;
    await this.systemMetaRepository.save({
      key,
      value: JSON.stringify({ failed_count: locked_until ? 0 : failedCount, locked_until }),
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

  private async recordIpFailure(ip: string, now: number): Promise<void> {
    const key = `login_ip_${ip}`;
    const meta = await this.systemMetaRepository.findOne({ where: { key } });
    let state = { failed_count: 0, delay_until: null as number | null };
    if (meta) { try { state = JSON.parse(meta.value); } catch {} }
    state.failed_count += 1;
    if (state.failed_count >= 10) {
      const delaySec = Math.floor(state.failed_count / 10) * 30;
      state.delay_until = now + delaySec * 1000;
    }
    await this.systemMetaRepository.save({ key, value: JSON.stringify(state) });
  }

  private async clearIpFailures(ip: string): Promise<void> {
    await this.systemMetaRepository.delete({ key: `login_ip_${ip}` });
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
