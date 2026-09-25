import { ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { authenticator } from 'otplib';
import * as qrcode from 'qrcode';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { AccountsService } from '../accounts/accounts.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { decryptSecret, encryptSecret } from '../common/crypto/totp-secret-cipher';
import {
  SqliteImmediateTransactionService,
  SqliteTransactionConnection,
} from '../common/database/sqlite-immediate-transaction.service';
import { Authenticator } from './entities/authenticator.entity';

export interface TotpSetupResult {
  secret: string;
  otpauth_url: string;
  qr_code_data_url: string;
}

export interface MatchedTotpStep {
  authenticatorId: string;
  timestamp: number;
}

@Injectable()
export class TotpService {
  private readonly totp = authenticator.create({ ...authenticator.options, window: 1 });

  constructor(
    @InjectRepository(Authenticator)
    private readonly authenticatorsRepository: Repository<Authenticator>,
    private readonly accountsService: AccountsService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly sqliteTransactions: SqliteImmediateTransactionService,
  ) {}

  async hasActiveTotp(accountId: string): Promise<boolean> {
    return !!(await this.authenticatorsRepository.findOne({
      where: { accountId, type: 'totp', isActive: 1 },
    }));
  }

  async setup(accountId: string): Promise<TotpSetupResult> {
    const account = await this.accountsService.findById(accountId);
    if (!account) throw new NotFoundException('Account not found');

    // A pending row observed before taking the write lock may be replaced. If a
    // different row appeared while this request waited for the lock, another
    // setup won the race and this response must not invalidate its secret.
    const observedPending = await this.authenticatorsRepository.findOne({
      where: { accountId, type: 'totp', isActive: 0 },
    });
    const secret = this.totp.generateSecret();
    const encryptedSecret = encryptSecret(secret, this.jwtSecret());
    const authenticatorId = uuidv4();
    const createdAt = Date.now();
    const otpauthUrl = this.totp.keyuri(account.username, 'FileStation', secret);
    const qrCodeDataUrl = await qrcode.toDataURL(otpauthUrl);

    try {
      await this.sqliteTransactions.run(async (connection) => {
        const active = await connection.get<{ id: string }>(
          'SELECT id FROM authenticators WHERE account_id = ? AND type = ? AND is_active = ?',
          [accountId, 'totp', 1],
        );
        if (active) {
          throw new ConflictException({ code: 'TOTP_ALREADY_ENABLED', message: 'TOTP is already enabled; disable it first' });
        }

        const pending = await connection.get<{ id: string }>(
          'SELECT id FROM authenticators WHERE account_id = ? AND type = ? AND is_active = ?',
          [accountId, 'totp', 0],
        );
        if (pending && pending.id !== observedPending?.id) {
          throw new ConflictException({ code: 'TOTP_SETUP_IN_PROGRESS', message: 'A TOTP setup is already in progress' });
        }

        await connection.run(
          'DELETE FROM authenticators WHERE account_id = ? AND type = ? AND is_active = ?',
          [accountId, 'totp', 0],
        );
        await connection.run(
          'INSERT INTO authenticators (id, account_id, type, name, totp_secret_encrypted, credential_id, public_key, sign_count, transports, created_at, last_used_at, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [authenticatorId, accountId, 'totp', 'TOTP', encryptedSecret, null, null, 0, null, createdAt, null, 0],
        );
      });
    } catch (error) {
      if ((error as { code?: string })?.code === 'SQLITE_CONSTRAINT') {
        throw new ConflictException({ code: 'TOTP_SETUP_IN_PROGRESS', message: 'A TOTP setup is already in progress' });
      }
      throw error;
    }

    return { secret, otpauth_url: otpauthUrl, qr_code_data_url: qrCodeDataUrl };
  }

  async confirm(accountId: string, code: string): Promise<void> {
    const pending = await this.authenticatorsRepository.findOne({
      where: { accountId, type: 'totp', isActive: 0 },
    });
    if (!pending?.totpSecretEncrypted) {
      throw new NotFoundException({ code: 'NO_PENDING_SETUP', message: 'No pending TOTP setup' });
    }

    const matchedStep = this.matchingStep(code, pending.totpSecretEncrypted);
    if (!matchedStep) {
      throw new UnauthorizedException({ code: 'INVALID_TOTP', message: 'Invalid TOTP code' });
    }

    if (!(await this.consumeStep(pending.id, 0, matchedStep.timestamp))) {
      throw new UnauthorizedException({ code: 'INVALID_TOTP', message: 'Invalid TOTP code' });
    }
    await this.auditService.record({ accountId, action: AuditAction.AUTH_TOTP_ENABLED });
  }

  async disable(accountId: string, password: string, code: string): Promise<void> {
    const account = await this.accountsService.findById(accountId);
    if (!account || !(await this.accountsService.validatePassword(account, password))) {
      throw new UnauthorizedException('Invalid password');
    }
    if (!(await this.verifyCode(accountId, code))) {
      throw new UnauthorizedException({ code: 'INVALID_TOTP', message: 'Invalid TOTP code' });
    }

    await this.sqliteTransactions.run(async (connection) => {
      const securitySetting = await connection.get<{ value: string }>(
        'SELECT value FROM settings WHERE key = ?', ['security'],
      );
      let totpRequired = false;
      if (securitySetting) {
        try {
          totpRequired = JSON.parse(securitySetting.value).totp_required === true;
        } catch {
          throw new ConflictException({
            code: 'TOTP_POLICY_UNAVAILABLE',
            message: 'TOTP policy could not be validated; review security settings and try again',
          });
        }
      }
      if (totpRequired) {
        throw new ConflictException({
          code: 'TOTP_REQUIRED',
          message: 'Disable the TOTP requirement before removing your authenticator',
        });
      }
      await connection.run(
        'DELETE FROM authenticators WHERE account_id = ? AND type = ?',
        [accountId, 'totp'],
      );
    });
    await this.auditService.record({ accountId, action: AuditAction.AUTH_TOTP_DISABLED });
  }

  async verifyCode(accountId: string, code: string): Promise<boolean> {
    const matched = await this.matchLoginCode(accountId, code);
    if (!matched) return false;
    return this.consumeStep(matched.authenticatorId, 1, matched.timestamp);
  }

  async matchLoginCode(accountId: string, code: string): Promise<MatchedTotpStep | null> {
    const row = await this.authenticatorsRepository.findOne({
      where: { accountId, type: 'totp', isActive: 1 },
    });
    if (!row?.totpSecretEncrypted) return null;
    const matchedStep = this.matchingStep(code, row.totpSecretEncrypted);
    if (!matchedStep) return null;
    return { authenticatorId: row.id, timestamp: matchedStep.timestamp };
  }

  async matchLoginCodeInTransaction(
    connection: SqliteTransactionConnection,
    accountId: string,
    code: string,
  ): Promise<MatchedTotpStep | null> {
    const row = await connection.get<{ id: string; totp_secret_encrypted: string | null }>(
      'SELECT id, totp_secret_encrypted FROM authenticators WHERE account_id = ? AND type = ? AND is_active = ?',
      [accountId, 'totp', 1],
    );
    if (!row?.totp_secret_encrypted) return null;
    const matchedStep = this.matchingStep(code, row.totp_secret_encrypted);
    if (!matchedStep) return null;
    return { authenticatorId: row.id, timestamp: matchedStep.timestamp };
  }

  async consumeLoginStep(connection: SqliteTransactionConnection, matched: MatchedTotpStep): Promise<boolean> {
    return this.updateConsumedStep(connection, matched.authenticatorId, 1, matched.timestamp);
  }

  private async updateConsumedStep(
    connection: SqliteTransactionConnection,
    authenticatorId: string,
    expectedActive: 0 | 1,
    timestamp: number,
  ): Promise<boolean> {
    const result = await connection.run(
      'UPDATE authenticators SET last_used_at = ?, is_active = 1 WHERE id = ? AND type = ? AND is_active = ? AND (last_used_at IS NULL OR last_used_at < ?)',
      [timestamp, authenticatorId, 'totp', expectedActive, timestamp],
    );
    return result.changes === 1;
  }

  private matchingStep(code: string, encryptedSecret: string): { counter: number; timestamp: number } | null {
    try {
      const now = Date.now();
      const options = this.totp.allOptions();
      const stepMillis = options.step * 1000;
      const verifier = this.totp.create({ ...options, epoch: now });
      const delta = verifier.checkDelta(code, decryptSecret(encryptedSecret, this.jwtSecret()));
      if (delta === null) return null;
      const counter = Math.floor(now / stepMillis) + delta;
      return { counter, timestamp: counter * stepMillis };
    } catch {
      return null;
    }
  }

  private async consumeStep(authenticatorId: string, expectedActive: 0 | 1, timestamp: number): Promise<boolean> {
    return this.sqliteTransactions.run((connection) =>
      this.updateConsumedStep(connection, authenticatorId, expectedActive, timestamp),
    );
  }

  private jwtSecret(): string {
    const secret = this.configService.get<string>('app.jwtSecret');
    if (!secret) throw new Error('JWT_SECRET not configured');
    return secret;
  }
}
