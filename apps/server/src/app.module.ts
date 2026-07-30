import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { AccountsModule } from './accounts/accounts.module';
import { SecurityModule } from './security/security.module';
import { FilesModule } from './files/files.module';
import { FoldersModule } from './folders/folders.module';
import { SharesModule } from './shares/shares.module';
import { SettingsModule } from './settings/settings.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [configuration],
      isGlobal: true,
    }),
    ScheduleModule.forRoot(), // @Cron 生效前提（FileLifecycleService）
    DatabaseModule,
    SecurityModule,
    AuthModule,
    AccountsModule,
    SettingsModule,
    FilesModule,
    FoldersModule,
    SharesModule,
  ],
})
export class AppModule {}
