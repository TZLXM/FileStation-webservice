import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SharesController } from './shares.controller';
import { DownloadsController } from './downloads.controller';
import { SharesService } from './shares.service';
import { DownloadService } from './download.service';
import { DownloadTicketService } from './download-ticket.service';
import { Share } from './entities/share.entity';
import { DownloadSession } from './entities/download-session.entity';
import { DownloadTicket } from './entities/download-ticket.entity';
import { File } from '../files/entities/file.entity';
import { SecurityModule } from '../security/security.module';
import { FilesModule } from '../files/files.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Share, DownloadSession, DownloadTicket, File]),
    SecurityModule,
    FilesModule, // StorageService
  ],
  controllers: [SharesController, DownloadsController],
  providers: [SharesService, DownloadService, DownloadTicketService],
  exports: [SharesService, DownloadService, DownloadTicketService],
})
export class SharesModule {}
