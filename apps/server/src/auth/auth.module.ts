import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TotpService } from './totp.service';
import { AccountsModule } from '../accounts/accounts.module';
import { SecurityModule } from '../security/security.module';
import { SettingsModule } from '../settings/settings.module';
import { Session } from './entities/session.entity';
import { LoginChallenge } from './entities/login-challenge.entity';
import { SystemMeta } from './entities/system-meta.entity';
import { Authenticator } from './entities/authenticator.entity';
import { ApiTokensModule } from '../api-tokens/api-tokens.module';
import { AuditModule } from '../audit/audit.module';
import { SqliteImmediateTransactionModule } from '../common/database/sqlite-immediate-transaction.module';

@Module({
  imports: [
    AccountsModule,
    PassportModule,
    SecurityModule, // JwtModule/JwtStrategy/JwtAuthGuard
    SettingsModule, // SettingsService（登录锁定）
    ApiTokensModule,
    AuditModule,
    SqliteImmediateTransactionModule,
    TypeOrmModule.forFeature([Session, LoginChallenge, SystemMeta, Authenticator]),
  ],
  controllers: [AuthController],
  providers: [AuthService, TotpService],
  exports: [AuthService],
})
export class AuthModule {}
