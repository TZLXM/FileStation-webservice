import { ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { authenticator } from 'otplib';
import * as qrcode from 'qrcode';
import { DataSource, QueryRunner, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { AccountsService } from '../accounts/accounts.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { decryptSecret, encryptSecret } from '../common/crypto/totp-secret-cipher';
import { beginImmediate, safeRollback } from '../common/database/tx.helper';
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
    private readonly dataSource: DataSource,
  ) {}

  async hasActiveTotp(accountId: string): Promise<boolean> {
    return !!(await this.authenticatorsRepository.findOne({
      where: { accountId, type: 'totp', isActive: 1 },
    }));
  }

  async setup(accountId: string): Promise<TotpSetupResult> {
    if (await this.hasActiveTotp(accountId)) {
      throw new ConflictException({ code: 'TOTP_ALREADY_ENABLED', message: 'TOTP is already enabled; disable it first' });
    }

    const account = await this.accountsService.findById(accountId);
    if (!account) throw new NotFoundException('Account not found');

    await this.authenticatorsRepository.delete({ accountId, type: 'totp', isActive: 0 });

    const secret = this.totp.generateSecret();
    await this.authenticatorsRepository.save({
      id: uuidv4(),
      accountId,
      type: 'totp',
      name: 'TOTP',
      totpSecretEncrypted: encryptSecret(secret, this.jwtSecret()),
      credentialId: null,
      publicKey: null,
      signCount: 0,
      transports: null,
      createdAt: Date.now(),
      lastUsedAt: null,
      isActive: 0,
    });

    const otpauthUrl = this.totp.keyuri(account.username, 'FileStation', secret);
    const qrCodeDataUrl = await qrcode.toDataURL(otpauthUrl);
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

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await beginImmediate(queryRunner);
      const rows = await queryRunner.query('SELECT value FROM settings WHERE key = ?', ['security']);
      const securitySetting = rows[0] as { value: string } | undefined;
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
      await queryRunner.query(
        'DELETE FROM authenticators WHERE account_id = ? AND type = ?',
        [accountId, 'totp'],
      );
      await queryRunner.query('COMMIT');
    } catch (error) {
      await safeRollback(queryRunner);
      throw error;
    } finally {
      await queryRunner.release();
    }
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

  async consumeLoginStep(queryRunner: QueryRunner, matched: MatchedTotpStep): Promise<boolean> {
    return this.updateConsumedStep(queryRunner, matched.authenticatorId, 1, matched.timestamp);
  }

  private async updateConsumedStep(
    queryRunner: QueryRunner,
    authenticatorId: string,
    expectedActive: 0 | 1,
    timestamp: number,
  ): Promise<boolean> {
    const result = await queryRunner.query(
      'UPDATE authenticators SET last_used_at = ?, is_active = 1 WHERE id = ? AND type = ? AND is_active = ? AND (last_used_at IS NULL OR last_used_at < ?)',
      [timestamp, authenticatorId, 'totp', expectedActive, timestamp],
      true,
    ) as { affected?: number };
    return result?.affected === 1;
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
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await beginImmediate(queryRunner);
      const consumed = await this.updateConsumedStep(queryRunner, authenticatorId, expectedActive, timestamp);
      await queryRunner.query('COMMIT');
      return consumed;
    } catch (error) {
      await safeRollback(queryRunner);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private jwtSecret(): string {
    const secret = this.configService.get<string>('app.jwtSecret');
    if (!secret) throw new Error('JWT_SECRET not configured');
    return secret;
  }
}
