import { Controller, Get, Post, Delete, Param, Body, Query, UseGuards, Res, Req, Headers, BadRequestException, HttpCode, HttpStatus } from '@nestjs/common';
import { Response, Request } from 'express';
import { SharesService } from './shares.service';
import { DownloadService } from './download.service';
import { DownloadTicketService } from './download-ticket.service';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { CreateShareDto } from './dto/create-share.dto';
import { ShareAccessDto } from './dto/share-access.dto';
import { ShareType, ShareProtection } from './entities/share.entity';
import { ApiResponse, ShareInfo } from '@filestation/shared';
import { writeDownloadHeaders } from '../common/http/download-response';
import { RequireScopes } from '../security/decorators/require-scopes.decorator';
import { AuditAction, AuditService } from '../audit/audit.service';

@Controller('shares')
export class SharesController {
  constructor(
    private sharesService: SharesService,
    private downloadService: DownloadService,
    private downloadTicketService: DownloadTicketService, // v1.6 修正：v1.5 调用它但未注入（编译错误）
    private auditService: AuditService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @RequireScopes('shares:write')
  async create(@Body() body: CreateShareDto, @Req() req: Request): Promise<ApiResponse<{ share_id: string; share_url: string }>> {
    const share = await this.sharesService.createShare(
      body.file_id,
      ShareType.PAGE,
      body.protection as ShareProtection,
      body.protection === 'password' ? body.password! : null,
      body.max_downloads ?? null, // DTO 已保证非 0，用 ?? 而非 ||
      body.expires_at ? new Date(body.expires_at) : null,
      (req as any).user.id,
    );
    await this.auditService.record({
      accountId: (req as any).user.id,
      action: AuditAction.SHARE_CREATED,
      resourceType: 'share',
      resourceId: share.id,
      details: { protection: body.protection, max_downloads: body.max_downloads ?? null },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return { code: 'OK', message: 'Share created', data: { share_id: share.id, share_url: `/s/${share.id}` }, request_id: crypto.randomUUID() };
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @RequireScopes('shares:read')
  async listByFile(@Query('file_id') fileId: string): Promise<ApiResponse<any[]>> {
    if (!fileId) throw new BadRequestException('file_id is required');
    const shares = await this.sharesService.findByFile(fileId);
    return {
      code: 'OK',
      message: 'Shares retrieved',
      data: shares.map((s) => ({
        id: s.id,
        share_url: `/s/${s.id}`,
        protection: s.protection,
        status: s.status,
        max_downloads: s.maxDownloads,
        used_downloads: s.usedDownloads,
        expires_at: s.expiresAt ? new Date(s.expiresAt).toISOString() : null,
        created_at: new Date(s.createdAt).toISOString(),
      })),
      request_id: crypto.randomUUID(),
    };
  }

  @Get(':id')
  async getInfo(@Param('id') id: string): Promise<ApiResponse<ShareInfo>> {
    const info = await this.sharesService.getShareInfo(id);
    return { code: 'OK', message: 'Share info', data: info, request_id: crypto.randomUUID() };
  }

  // v1.6：统一 access 端点（替代旧 /access + /verify）
  @Post(':id/access')
  @HttpCode(HttpStatus.OK)
  async access(@Param('id') id: string, @Body() body?: ShareAccessDto): Promise<ApiResponse<{ download_token: string; expires_at: string; file_info: ShareInfo }>> {
    // body?.password：免密 POST 空 body 不抛 TypeError
    const result = await this.sharesService.accessShare(id, body?.password);
    return { code: 'OK', message: 'Access granted', data: result, request_id: crypto.randomUUID() };
  }

  @Post(':id/download-ticket')
  @HttpCode(HttpStatus.OK)
  async createDownloadTicket(@Param('id') id: string, @Headers('authorization') authHeader: string): Promise<ApiResponse<{ ticket_url: string; expires_at: string }>> {
    const token = this.extractBearer(authHeader);
    const session = await this.sharesService.validateDownloadToken(token);
    // 复验：share 吊销/过期、session 过期、file 非 active 时禁止签发票据
    await this.sharesService.validateAuthorizedDownload(id, session);

    const ticket = await this.downloadTicketService.createTicket(session.id);
    return {
      code: 'OK',
      message: 'Download ticket created',
      data: { ticket_url: `/api/v1/downloads/${ticket.token}`, expires_at: ticket.expiresAt },
      request_id: crypto.randomUUID(),
    };
  }

  @Get(':id/content')
  async download(@Param('id') id: string, @Headers('authorization') authHeader: string, @Headers('range') rangeHeader: string | undefined, @Res() res: Response): Promise<void> {
    const token = this.extractBearer(authHeader);
    const session = await this.sharesService.validateDownloadToken(token);
    await this.sharesService.validateAuthorizedDownload(id, session); // 统一四层复验

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

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @RequireScopes('shares:write')
  async revoke(@Param('id') id: string, @Req() req: Request): Promise<ApiResponse<null>> {
    await this.sharesService.revokeShare(id);
    await this.auditService.record({
      accountId: (req as any).user.id,
      action: AuditAction.SHARE_REVOKED,
      resourceType: 'share',
      resourceId: id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return { code: 'OK', message: 'Share revoked', data: null, request_id: crypto.randomUUID() };
  }

  private extractBearer(authHeader: string | undefined): string {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new BadRequestException({ code: 'MISSING_TOKEN', message: 'Missing or invalid Authorization header' });
    }
    return authHeader.substring(7);
  }
}
