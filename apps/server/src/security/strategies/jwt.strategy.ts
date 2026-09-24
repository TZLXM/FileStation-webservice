import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccountsService } from '../../accounts/accounts.service';
import { ApiToken } from '../../api-tokens/entities/api-token.entity';
import { JwtPayload } from '@filestation/shared';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private accountsService: AccountsService,
    @InjectRepository(ApiToken)
    private apiTokensRepository: Repository<ApiToken>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('app.jwtSecret') || (() => { throw new Error('JWT_SECRET not configured'); })(),
    });
  }

  async validate(payload: JwtPayload) {
    if (payload.principal_type === 'admin') {
      const account = await this.accountsService.findById(payload.sub);
      if (!account) throw new UnauthorizedException('Account not found');
      return { id: account.id, username: account.username, principalType: 'admin' as const };
    }

    if (payload.principal_type === 'api_token') {
      if (!payload.token_id) throw new UnauthorizedException('Malformed api_token JWT');
      const token = await this.apiTokensRepository.findOne({ where: { id: payload.token_id } });
      if (!token || token.revokedAt !== null) throw new UnauthorizedException('API token revoked');
      if (token.expiresAt !== null && token.expiresAt <= Date.now()) throw new UnauthorizedException('API token expired');
      const account = await this.accountsService.findById(token.accountId);
      if (!account) throw new UnauthorizedException('Account not found');
      return {
        id: account.id,
        username: `api:${token.name}`,
        principalType: 'api_token' as const,
        tokenId: token.id,
        scopes: JSON.parse(token.scopes) as string[], // 以 DB 为准，防 JWT 伪造放大
      };
    }

    throw new UnauthorizedException('Invalid token type');
  }
}
