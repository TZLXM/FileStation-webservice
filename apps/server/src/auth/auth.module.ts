import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AccountsModule } from '../accounts/accounts.module';
import { SecurityModule } from '../security/security.module';
import { SettingsModule } from '../settings/settings.module';
import { Session } from './entities/session.entity';
import { LoginChallenge } from './entities/login-challenge.entity';
import { SystemMeta } from './entities/system-meta.entity';
import { ApiTokensModule } from '../api-tokens/api-tokens.module';

@Module({
  imports: [
    AccountsModule,
    PassportModule,
    SecurityModule, // JwtModule/JwtStrategy/JwtAuthGuard
    SettingsModule, // SettingsService（登录锁定）
    ApiTokensModule,
    TypeOrmModule.forFeature([Session, LoginChallenge, SystemMeta]),
  ],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
