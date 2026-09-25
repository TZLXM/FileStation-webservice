import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FilesController } from './files.controller';
import { UploadsController } from './uploads.controller';
import { FilesService } from './files.service';
import { UploadsService } from './uploads.service';
import { StorageService } from './storage.service';
import { FileLifecycleService } from './file-lifecycle.service';
import { File } from './entities/file.entity';
import { UploadSession } from './entities/upload-session.entity';
import { UploadPart } from './entities/upload-part.entity';
import { Folder } from '../folders/entities/folder.entity';
import { SecurityModule } from '../security/security.module';
import { SettingsModule } from '../settings/settings.module';
import { AuditModule } from '../audit/audit.module';
import { SqliteImmediateTransactionModule } from '../common/database/sqlite-immediate-transaction.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([File, UploadSession, UploadPart, Folder]),
    SecurityModule,
    SettingsModule,
    AuditModule,
    SqliteImmediateTransactionModule,
  ],
  controllers: [FilesController, UploadsController],
  providers: [FilesService, UploadsService, StorageService, FileLifecycleService],
  exports: [FilesService, UploadsService, StorageService],
})
export class FilesModule {}
