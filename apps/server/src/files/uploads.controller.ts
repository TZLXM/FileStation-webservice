import { Controller, Post, Put, Get, Delete, Body, Param, Headers, UseGuards, Req, Res, BadRequestException, HttpCode, HttpStatus } from '@nestjs/common';
import { UploadsService } from './uploads.service';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { InitUploadDto } from './dto/init-upload.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { ApiResponse } from '@filestation/shared';
import { Request, Response as ExpressResponse } from 'express';
import { RequireScopes } from '../security/decorators/require-scopes.decorator';
import { AuditAction, AuditService } from '../audit/audit.service';

@Controller('uploads')
export class UploadsController {
  constructor(private uploadsService: UploadsService, private auditService: AuditService) {}

  // 仅初始化上传需要管理员 JWT；分块/完成/状态/恢复/中止用 X-Upload-Token（匿名，支持断点续传客户端）
  @Post()
  @UseGuards(JwtAuthGuard)
  @RequireScopes('files:write')
  async initialize(@Body() body: InitUploadDto, @Req() req: Request) {
    const accountId = (req as any).user.id;
    const result = await this.uploadsService.initializeUpload(body, 'admin', accountId);
    await this.auditService.record({
      accountId,
      action: AuditAction.UPLOAD_INITIATED,
      resourceType: 'upload',
      resourceId: result.upload_id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return { code: 'OK', message: 'Upload initialized', data: result, request_id: crypto.randomUUID() };
  }

  @Put(':id/parts/:partNumber')
  @HttpCode(HttpStatus.OK)
  async uploadPart(
    @Param('id') uploadId: string,
    @Param('partNumber') partNumber: string,
    @Headers('x-upload-token') uploadToken: string,
    @Headers('x-part-checksum') checksum: string,
    @Req() req: Request,
  ) {
    if (!uploadToken || !checksum) {
      throw new BadRequestException('Missing X-Upload-Token or X-Part-Checksum header');
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const data = Buffer.concat(chunks);

    const result = await this.uploadsService.uploadPart(uploadId, parseInt(partNumber, 10), data, checksum, uploadToken);
    return { code: 'OK', message: 'Part received', data: result, request_id: crypto.randomUUID() };
  }

  @Get(':id')
  async getStatus(@Param('id') uploadId: string, @Headers('x-upload-token') uploadToken: string) {
    if (!uploadToken) throw new BadRequestException('Missing X-Upload-Token header');
    const result = await this.uploadsService.getUploadStatus(uploadId, uploadToken);
    return { code: 'OK', message: 'Upload status', data: result, request_id: crypto.randomUUID() };
  }

  @Post(':id/complete')
  async complete(
    @Param('id') uploadId: string,
    @Headers('x-upload-token') uploadToken: string,
    @Body() body: CompleteUploadDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    if (!uploadToken) throw new BadRequestException('Missing X-Upload-Token header');
    const requestAbort = new AbortController();
    const abortOnRequestAbort = () => requestAbort.abort();
    const abortOnResponseClose = () => {
      if (!res.writableEnded) requestAbort.abort();
    };
    req.once('aborted', abortOnRequestAbort);
    res.once('close', abortOnResponseClose);
    try {
      const result = await this.uploadsService.completeUpload(uploadId, uploadToken, body?.final_hash, requestAbort.signal);
      await this.auditService.record({
        accountId: null,
        action: AuditAction.UPLOAD_COMPLETED,
        resourceType: 'upload',
        resourceId: uploadId,
        details: { filename: result.filename, size: result.size },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return { code: 'OK', message: 'Upload completed', data: { file_id: result.file_id }, request_id: crypto.randomUUID() };
    } catch (error) {
      if (requestAbort.signal.aborted && error instanceof Error && error.name === 'AbortError') return;
      throw error;
    } finally {
      req.removeListener('aborted', abortOnRequestAbort);
      res.removeListener('close', abortOnResponseClose);
    }
  }

  @Post(':id/resume')
  async resume(@Param('id') uploadId: string, @Headers('x-upload-token') uploadToken: string) {
    if (!uploadToken) throw new BadRequestException('Missing X-Upload-Token header');
    const result = await this.uploadsService.resumeUpload(uploadId, uploadToken);
    return { code: 'OK', message: 'Upload resumed', data: result, request_id: crypto.randomUUID() };
  }

  @Delete(':id')
  async abort(@Param('id') uploadId: string, @Headers('x-upload-token') uploadToken: string) {
    if (!uploadToken) throw new BadRequestException('Missing X-Upload-Token header');
    await this.uploadsService.abortUpload(uploadId, uploadToken);
    return { code: 'OK', message: 'Upload aborted', data: null, request_id: crypto.randomUUID() };
  }
}
