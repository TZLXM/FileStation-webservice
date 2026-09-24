import { Module } from '@nestjs/common';
import { ApiTokensModule } from '../api-tokens/api-tokens.module';
import { AuditModule } from '../audit/audit.module';
import { FilesModule } from '../files/files.module';
import { FoldersModule } from '../folders/folders.module';
import { SettingsModule } from '../settings/settings.module';
import { SharesModule } from '../shares/shares.module';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

@Module({
  imports: [FilesModule, FoldersModule, SharesModule, SettingsModule, ApiTokensModule, AuditModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
