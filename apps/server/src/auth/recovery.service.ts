import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { AccountsService } from '../accounts/accounts.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { SqliteImmediateTransactionService, SqliteTransactionConnection } from '../common/database/sqlite-immediate-transaction.service';
import { hasActiveRecoveryIpReservation, settleExpiredRecoveryIpReservations, settleRecoveryIpSuccess } from './recovery-ip-reservations';
import { RecoveryCode } from './entities/recovery-code.entity';
import { TotpService } from './totp.service';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_TTL_MS = 24 * 60 * 60 * 1000;
const RECOVERY_LOCK_THRESHOLD = 5;
const RECOVERY_LOCK_MS = 15 * 60 * 1000;
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} satisfies argon2.HashOptions;
const DUMMY_RECOVERY_VALUE = 'filestation invalid recovery code comparison';

interface RecoveryFailureState {
  failed_count: number;
  locked_until: number | null;
}

type VerificationCommit =
  | { kind: 'accepted' }
  | { kind: 'invalid' }
  | { kind: 'locked'; retryAfterSec: number }
  | { kind: 'ip_reservation_expired' };

export interface RecoverySessionMaterial {
  id: string;
  accountId: string;
  refreshTokenHash: string;
  createdAt: number;
  expiresAt: number;
}

@Injectable()
export class RecoveryService {
  private readonly verificationTails = new Map<string, Promise<void>>();
  private dummyHashPromise?: Promise<string>;

  constructor(
    @InjectRepository(RecoveryCode)
    private readonly codesRepository: Repository<RecoveryCode>,
    private readonly accountsService: AccountsService,
    private readonly totpService: TotpService,
    private readonly auditService: AuditService,
    private readonly sqliteTransactions: SqliteImmediateTransactionService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async cleanupExpiredIpReservations(): Promise<void> {
    await this.sqliteTransactions.run((connection) =>
      settleExpiredRecoveryIpReservations(connection, Date.now()));
  }

  async generate(accountId: string, password: string, totpCode?: string): Promise<string[]> {
    const account = await this.accountsService.findById(accountId);
    if (!account || !(await this.accountsService.validatePassword(account, password))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (await this.totpService.hasActiveTotp(accountId)) {
      if (!totpCode || !(await this.totpService.verifyCode(accountId, totpCode))) {
        throw new UnauthorizedException({ code: 'TOTP_REQUIRED', message: 'Valid TOTP code is required' });
      }
    }

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => this.generateCode());
    // Argon2 work is deliberately completed before BEGIN IMMEDIATE.
    const codeHashes: string[] = [];
    for (const code of codes) {
      codeHashes.push(await argon2.hash(this.normalize(code), ARGON2_OPTIONS));
    }

    const now = Date.now();
    const rows: RecoveryCode[] = codeHashes.map((codeHash) => this.codesRepository.create({
        id: uuidv4(),
        accountId,
        codeHash,
        usedAt: null,
        createdAt: now,
        expiresAt: now + RECOVERY_CODE_TTL_MS,
      }));

    // Publish a complete new group atomically; no hash work or network work occurs under the write lock.
    await this.sqliteTransactions.run(async (connection) => {
      await connection.run('DELETE FROM recovery_codes WHERE account_id = ? AND used_at IS NULL', [accountId]);
      for (const row of rows) {
        await connection.run(
          'INSERT INTO recovery_codes (id, account_id, code_hash, used_at, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
          [row.id, row.accountId, row.codeHash, row.usedAt, row.createdAt, row.expiresAt],
        );
      }
    });

    await this.auditService.record({ accountId, action: AuditAction.RECOVERY_GENERATED });
    return codes;
  }

  async verify(
    username: string,
    code: string,
    clientIp?: string,
    session?: RecoverySessionMaterial,
    ipReservationId?: string,
  ): Promise<{ accountId: string }> {
    return this.serializeVerification(username, () => this.verifySerially(username, code, clientIp, session, ipReservationId));
  }

  private async verifySerially(
    username: string,
    code: string,
    clientIp?: string,
    session?: RecoverySessionMaterial,
    ipReservationId?: string,
  ): Promise<{ accountId: string }> {
    const verificationStartedAt = Date.now();
    await this.assertNotLocked(username, verificationStartedAt);

    const account = await this.accountsService.findByUsername(username);
    const candidates = account
      ? await this.codesRepository.find({
        where: { accountId: account.id, usedAt: IsNull(), expiresAt: MoreThan(verificationStartedAt) },
        order: { createdAt: 'ASC', id: 'ASC' },
      })
      : [];
    const normalized = this.normalize(code);
    const dummyHash = candidates.length < RECOVERY_CODE_COUNT ? await this.getDummyHash() : '';
    let matched: RecoveryCode | null = null;

    // Always do ten Argon2id comparisons so neither a match position nor an empty/nonexistent
    // account leaks through an early exit. Candidate hashes are loaded before opening any write tx.
    for (let index = 0; index < RECOVERY_CODE_COUNT; index += 1) {
      const candidate = candidates[index];
      const hash = candidate?.codeHash ?? dummyHash;
      let isMatch = false;
      try {
        isMatch = await argon2.verify(hash, normalized);
      } catch {
        // A malformed stored hash is treated as a non-match and never reflected to the caller.
      }
      if (candidate && isMatch && !matched) matched = candidate;
    }

    const failureKey = `recovery_fail_${username}`;
    const outcome = await this.sqliteTransactions.run(async (connection): Promise<VerificationCommit> => {
      const committedAt = Date.now();
      if (clientIp) {
        if (!ipReservationId) return { kind: 'ip_reservation_expired' };
        await settleExpiredRecoveryIpReservations(connection, committedAt);
        if (!await hasActiveRecoveryIpReservation(connection, clientIp, ipReservationId, committedAt)) {
          return { kind: 'ip_reservation_expired' };
        }
      }
      const state = await this.readFailureState(connection, failureKey);
      if (state.locked_until && state.locked_until > committedAt) {
        return { kind: 'locked', retryAfterSec: Math.ceil((state.locked_until - committedAt) / 1000) };
      }

      if (account && matched) {
        const claimed = await connection.run(
          'UPDATE recovery_codes SET used_at = ? WHERE id = ? AND account_id = ? AND used_at IS NULL AND expires_at > ?',
          [committedAt, matched.id, account.id, committedAt],
        );
        if (claimed.changes === 1) {
          if (!session || session.accountId !== account.id) {
            throw new Error('Recovery verification requires prepared session material for the matched account');
          }
          await connection.run(
            'UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL',
            [committedAt, account.id],
          );
          await connection.run(
            'INSERT INTO sessions (id, account_id, refresh_token_hash, device_info, created_at, expires_at, revoked_at) VALUES (?, ?, ?, NULL, ?, ?, NULL)',
            [session.id, session.accountId, session.refreshTokenHash, session.createdAt, session.expiresAt],
          );
          await connection.run('DELETE FROM system_meta WHERE key = ?', [failureKey]);
          if (clientIp) {
            const settled = await settleRecoveryIpSuccess(connection, clientIp, ipReservationId!, committedAt);
            if (!settled) throw new Error('Recovery IP reservation expired before session commit');
          }
          return { kind: 'accepted' };
        }
      }

      await this.recordFailure(connection, failureKey, state, committedAt);
      return { kind: 'invalid' };
    });

    if (outcome.kind === 'locked') {
      throw new UnauthorizedException({
        code: 'RECOVERY_LOCKED',
        message: 'Too many failed attempts, retry later',
        retry_after: outcome.retryAfterSec,
      });
    }
    if (outcome.kind === 'ip_reservation_expired') {
      throw new UnauthorizedException({
        code: 'IP_THROTTLED',
        message: 'Recovery verification attempt expired, please retry',
        retry_after: 1,
      });
    }
    if (outcome.kind === 'invalid' || !account) {
      throw new UnauthorizedException({ code: 'INVALID_RECOVERY_CODE', message: 'Invalid or expired recovery code' });
    }

    await this.auditService.record({ accountId: account.id, action: AuditAction.RECOVERY_USED, ip: clientIp });
    return { accountId: account.id };
  }

  private async assertNotLocked(username: string, now: number): Promise<void> {
    const key = `recovery_fail_${username}`;
    const state = await this.sqliteTransactions.run((connection) => this.readFailureState(connection, key));
    if (state.locked_until && state.locked_until > now) {
      throw new UnauthorizedException({
        code: 'RECOVERY_LOCKED',
        message: 'Too many failed attempts, retry later',
        retry_after: Math.ceil((state.locked_until - now) / 1000),
      });
    }
  }

  private async readFailureState(connection: SqliteTransactionConnection, key: string): Promise<RecoveryFailureState> {
    const meta = await connection.get<{ value: string }>('SELECT value FROM system_meta WHERE key = ?', [key]);
    if (!meta) return { failed_count: 0, locked_until: null };
    try {
      const state = JSON.parse(meta.value) as Partial<RecoveryFailureState>;
      return {
        failed_count: Number.isSafeInteger(state.failed_count) && (state.failed_count as number) >= 0
          ? state.failed_count as number
          : 0,
        locked_until: typeof state.locked_until === 'number' && Number.isFinite(state.locked_until)
          ? state.locked_until
          : null,
      };
    } catch {
      return { failed_count: 0, locked_until: null };
    }
  }

  private async recordFailure(
    connection: SqliteTransactionConnection,
    key: string,
    current: RecoveryFailureState,
    now: number,
  ): Promise<void> {
    const base = current.locked_until && current.locked_until <= now ? 0 : current.failed_count;
    const failedCount = base + 1;
    const lockedUntil = failedCount >= RECOVERY_LOCK_THRESHOLD ? now + RECOVERY_LOCK_MS : null;
    const state = { failed_count: lockedUntil ? 0 : failedCount, locked_until: lockedUntil };
    await connection.run(
      'INSERT INTO system_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, JSON.stringify(state)],
    );
  }

  private async getDummyHash(): Promise<string> {
    this.dummyHashPromise ??= argon2.hash(DUMMY_RECOVERY_VALUE, ARGON2_OPTIONS);
    return this.dummyHashPromise;
  }

  private generateCode(): string {
    const raw = Array.from(randomBytes(10), (byte) => CROCKFORD[byte % CROCKFORD.length]).join('');
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 10)}`;
  }

  private normalize(code: string): string {
    return code.replace(/[-\s]/g, '').toUpperCase();
  }

  private async serializeVerification<T>(username: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.verificationTails.get(username) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.verificationTails.set(username, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.verificationTails.get(username) === current) this.verificationTails.delete(username);
    }
  }
}
