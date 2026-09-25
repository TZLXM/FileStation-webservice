import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { Setting } from './entities/setting.entity';
import { Authenticator } from '../auth/entities/authenticator.entity';
import { SecurityModule } from '../security/security.module';
import { AuditModule } from '../audit/audit.module';
import { SqliteImmediateTransactionModule } from '../common/database/sqlite-immediate-transaction.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Setting, Authenticator]),
    SecurityModule,
    AuditModule,
    SqliteImmediateTransactionModule,
  ],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService], // 供 FilesModule/AuthModule 注入
})
export class SettingsModule {}
