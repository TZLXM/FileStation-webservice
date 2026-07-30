import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AccountsService } from '../../accounts/accounts.service';
import { JwtPayload } from '@filestation/shared';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private accountsService: AccountsService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('app.jwtSecret') || (() => { throw new Error('JWT_SECRET not configured'); })(),
    });
  }

  async validate(payload: JwtPayload) {
    if (payload.principal_type !== 'admin') {
      throw new UnauthorizedException('Invalid token type');
    }

    const account = await this.accountsService.findById(payload.sub);
    if (!account) {
      throw new UnauthorizedException('Account not found');
    }

    return {
      id: account.id,
      username: account.username,
      principalType: 'admin' as const,
    };
  }
}
