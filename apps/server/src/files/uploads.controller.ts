import { Controller, Post, Put, Get, Delete, Body, Param, Headers, UseGuards, Req, BadRequestException, HttpCode, HttpStatus } from '@nestjs/common';
import { UploadsService } from './uploads.service';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { InitUploadDto } from './dto/init-upload.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { ApiResponse } from '@filestation/shared';
import { Request } from 'express';

@Controller('uploads')
@UseGuards(JwtAuthGuard)
export class UploadsController {
  constructor(private uploadsService: UploadsService) {}

  @Post()
  async initialize(@Body() body: InitUploadDto, @Req() req: Request) {
    const result = await this.uploadsService.initializeUpload(body, 'admin', (req as any).user.id);
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
  async complete(@Param('id') uploadId: string, @Headers('x-upload-token') uploadToken: string, @Body() body: CompleteUploadDto) {
    if (!uploadToken) throw new BadRequestException('Missing X-Upload-Token header');
    const result = await this.uploadsService.completeUpload(uploadId, uploadToken, body?.final_hash);
    return { code: 'OK', message: 'Upload completed', data: result, request_id: crypto.randomUUID() };
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
