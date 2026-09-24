import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { API_TOKEN_SCOPES, ApiTokenInfo, ApiTokenScope } from '@filestation/shared';
import { ApiToken } from './entities/api-token.entity';

@Injectable()
export class ApiTokensService {
  constructor(
    @InjectRepository(ApiToken)
    private tokensRepository: Repository<ApiToken>,
  ) {}

  async createToken(
    accountId: string,
    name: string,
    scopes: ApiTokenScope[],
    expiresInDays: number | null,
  ): Promise<{ record: ApiTokenInfo; plaintext: string }> {
    const invalid = scopes.filter((scope) => !API_TOKEN_SCOPES.includes(scope));
    if (invalid.length > 0) {
      throw new BadRequestException({
        code: 'INVALID_SCOPES',
        message: `Invalid scopes: ${invalid.join(', ')}`,
      });
    }
    if (scopes.length === 0) {
      throw new BadRequestException({ code: 'EMPTY_SCOPES', message: 'At least one scope is required' });
    }

    const plaintext = `fs_api_${randomBytes(24).toString('hex')}`;
    const now = Date.now();
    const entity = await this.tokensRepository.save({
      id: uuidv4(),
      accountId,
      name,
      tokenPrefix: plaintext.substring(0, 12),
      tokenHash: this.hash(plaintext),
      scopes: JSON.stringify(scopes),
      expiresAt: expiresInDays ? now + expiresInDays * 86_400_000 : null,
      createdAt: now,
      lastUsedAt: null,
      lastUsedIp: null,
      revokedAt: null,
    });

    return { record: this.toInfo(entity), plaintext };
  }

  async listTokens(accountId: string): Promise<ApiTokenInfo[]> {
    const rows = await this.tokensRepository.find({ where: { accountId }, order: { createdAt: 'DESC' } });
    return rows.map((row) => this.toInfo(row));
  }

  async revokeToken(accountId: string, tokenId: string): Promise<void> {
    const result = await this.tokensRepository.update(
      { id: tokenId, accountId },
      { revokedAt: Date.now() },
    );
    if (result.affected === 0) {
      throw new NotFoundException('API token not found');
    }
  }

  /** Shared by exchange and MCP authentication: hash lookup plus revoke/expiry checks. */
  async validatePlaintext(raw: string): Promise<ApiToken | null> {
    if (!/^fs_api_[0-9a-f]{48}$/.test(raw)) return null;

    const row = await this.tokensRepository.findOne({ where: { tokenHash: this.hash(raw) } });
    if (!row || row.revokedAt !== null) return null;
    if (row.expiresAt !== null && row.expiresAt <= Date.now()) return null;
    return row;
  }

  /** Record token use at most once per 60 seconds to avoid excess writes. */
  async touchLastUsed(tokenId: string, ip: string): Promise<void> {
    const now = Date.now();
    const cutoff = now - 60_000;
    await this.tokensRepository.update(
      [
        { id: tokenId, lastUsedAt: IsNull() },
        { id: tokenId, lastUsedAt: LessThanOrEqual(cutoff) },
      ],
      { lastUsedAt: now, lastUsedIp: ip },
    );
  }

  private hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private toInfo(entity: ApiToken): ApiTokenInfo {
    return {
      id: entity.id,
      name: entity.name,
      token_prefix: entity.tokenPrefix,
      scopes: JSON.parse(entity.scopes),
      expires_at: entity.expiresAt ? new Date(entity.expiresAt).toISOString() : null,
      created_at: new Date(entity.createdAt).toISOString(),
      last_used_at: entity.lastUsedAt ? new Date(entity.lastUsedAt).toISOString() : null,
      last_used_ip: entity.lastUsedIp,
      revoked_at: entity.revokedAt ? new Date(entity.revokedAt).toISOString() : null,
    };
  }
}
