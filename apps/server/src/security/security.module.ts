import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AccountsModule } from '../accounts/accounts.module';

/**
 * SecurityModule：JwtModule 注册 + JwtStrategy + JwtAuthGuard。
 * v1.6 抽取原因：AuthService 需注入 SettingsService（登录锁定），SettingsController 需 JwtAuthGuard。
 * 若 JwtAuthGuard 留在 AuthModule，则 AuthModule↔SettingsModule 直接循环。
 * 抽取后依赖链单向：FilesModule/SharesModule/FoldersModule/SettingsModule/AuthModule → SecurityModule。
 */
@Module({
  imports: [
    AccountsModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('app.jwtSecret') || (() => { throw new Error('JWT_SECRET not configured'); })(),
        signOptions: { expiresIn: configService.get<string>('app.jwtExpiresIn') || '24h' },
      }),
    }),
  ],
  providers: [JwtStrategy, JwtAuthGuard],
  exports: [JwtModule, JwtStrategy, JwtAuthGuard],
})
export class SecurityModule {}
