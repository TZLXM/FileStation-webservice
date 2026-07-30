import { Controller, Get, Param, Res, Headers } from '@nestjs/common';
import { Response } from 'express';
import { DownloadTicketService } from './download-ticket.service';
import { DownloadService } from './download.service';
import { SharesService } from './shares.service';
import { writeDownloadHeaders } from '../common/http/download-response';

@Controller('downloads')
export class DownloadsController {
  constructor(
    private downloadTicketService: DownloadTicketService,
    private downloadService: DownloadService,
    private sharesService: SharesService, // v1.6 新增：四层复验
  ) {}

  @Get(':ticket')
  async download(@Param('ticket') ticket: string, @Headers('range') rangeHeader: string | undefined, @Res() res: Response): Promise<void> {
    // 1. 票据有效（未吊销、未过期）——票据 15 分钟、可重复用于多个 Range 请求
    const ticketEntity = await this.downloadTicketService.validateTicket(ticket);
    const session = ticketEntity.downloadSession;

    // 2. 统一四层复验：session 未过期、share 未吊销、share 未过期、file active
    await this.sharesService.validateAuthorizedDownload(session.shareId, session);

    // 3. 准备下载（Range 解析 + 计数抢占 + 文件流）
    const result = await this.downloadService.prepareDownload(session, rangeHeader);

    writeDownloadHeaders(res, {
      filename: result.file.filename,
      mimeType: result.file.mimeType,
      size: result.totalSize,
      start: result.start,
      end: result.end,
      isPartial: result.isPartial,
    });
    result.stream.pipe(res);
  }
}
