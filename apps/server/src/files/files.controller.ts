import { Controller, Get, Post, Patch, Delete, Param, Query, Body, UseGuards, Res, Headers, Req, BadRequestException } from '@nestjs/common';
import { FilesService } from './files.service';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { UpdateFileDto } from './dto/update-file.dto';
import { ExtendFileDto } from './dto/extend-file.dto';
import { ListFilesQueryDto } from './dto/list-files-query.dto';
import { File, FileStatus } from './entities/file.entity';
import { parseRangeHeader } from '../common/http/range-parser';
import { RangeNotSatisfiableException } from '../common/http/range-not-satisfiable.exception';
import { writeDownloadHeaders } from '../common/http/download-response';
import { ApiResponse, PaginatedResponse, FileMetadata } from '@filestation/shared';
import { Request, Response } from 'express';
import { RequireScopes } from '../security/decorators/require-scopes.decorator';
import { AuditAction, AuditService } from '../audit/audit.service';

@Controller('files')
@UseGuards(JwtAuthGuard)
export class FilesController {
  constructor(private filesService: FilesService, private auditService: AuditService) {}

  @Get()
  @RequireScopes('files:read')
  async findAll(@Query() query: ListFilesQueryDto): Promise<ApiResponse<PaginatedResponse<FileMetadata>>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const result = await this.filesService.findAll(page, pageSize, query.folder_id);
    return {
      code: 'OK',
      message: 'Files retrieved',
      data: {
        items: result.items.map((f) => this.toMetadata(f)),
        total: result.total,
        page,
        page_size: pageSize,
        total_pages: Math.ceil(result.total / pageSize),
      },
      request_id: crypto.randomUUID(),
    };
  }

  @Get(':id')
  @RequireScopes('files:read')
  async findOne(@Param('id') id: string): Promise<ApiResponse<FileMetadata>> {
    const file = await this.filesService.findOne(id);
    return { code: 'OK', message: 'File retrieved', data: this.toMetadata(file), request_id: crypto.randomUUID() };
  }

  @Get(':id/content')
  @RequireScopes('files:read')
  async getContent(
    @Param('id') id: string,
    @Headers('range') rangeHeader: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.filesService.getActiveFile(id);
    const parsed = parseRangeHeader(rangeHeader, file.size);
    if (parsed.status === 'invalid' || parsed.status === 'unsatisfiable') {
      throw new RangeNotSatisfiableException(file.size);
    }
    const isPartial = parsed.status === 'partial';
    const stream = await this.filesService.getFileStreamFor(
      file,
      isPartial ? { start: (parsed as any).start, end: (parsed as any).end } : undefined,
    );
    writeDownloadHeaders(res, {
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.size,
      start: isPartial ? (parsed as any).start : 0,
      end: isPartial ? (parsed as any).end : file.size - 1,
      isPartial,
    });
    stream.pipe(res);
  }

  @Patch(':id')
  @RequireScopes('files:write')
  async update(@Param('id') id: string, @Body() dto: UpdateFileDto): Promise<ApiResponse<FileMetadata>> {
    // expires_at 显式 null = 永久保留
    if (dto.expires_at === null) {
      const file = await this.filesService.setPermanent(id);
      return { code: 'OK', message: 'File set to permanent', data: this.toMetadata(file), request_id: crypto.randomUUID() };
    }

    const updateData: Partial<File> = {};
    if (dto.filename !== undefined) updateData.filename = dto.filename;
    if (dto.folder_id !== undefined) updateData.folderId = dto.folder_id;
    if (dto.expires_at !== undefined) {
      const ts = new Date(dto.expires_at).getTime();
      updateData.expiresAt = ts;
      if (ts > Date.now()) {
        updateData.expiredAt = null;
        updateData.status = FileStatus.ACTIVE;
      }
    }
    if (Object.keys(updateData).length === 0) {
      throw new BadRequestException('No update fields provided');
    }

    const file = await this.filesService.update(id, updateData);
    return { code: 'OK', message: 'File updated', data: this.toMetadata(file), request_id: crypto.randomUUID() };
  }

  @Post(':id/extend')
  @RequireScopes('files:write')
  async extend(@Param('id') id: string, @Body() dto: ExtendFileDto): Promise<ApiResponse<FileMetadata>> {
    const file = await this.filesService.extend(id, dto.hours);
    return { code: 'OK', message: 'File extended', data: this.toMetadata(file), request_id: crypto.randomUUID() };
  }

  @Delete(':id')
  @RequireScopes('files:write')
  async delete(@Param('id') id: string, @Req() req: Request): Promise<ApiResponse<null>> {
    await this.filesService.delete(id);
    await this.auditService.record({
      accountId: (req as any).user.id,
      action: AuditAction.FILE_DELETED,
      resourceType: 'file',
      resourceId: id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return { code: 'OK', message: 'File deletion queued', data: null, request_id: crypto.randomUUID() };
  }

  private toMetadata(file: File): FileMetadata {
    return {
      id: file.id,
      filename: file.filename,
      size: file.size,
      mime_type: file.mimeType,
      hash_sha256: file.hashSha256,
      status: file.status,
      expires_at: file.expiresAt ? new Date(file.expiresAt).toISOString() : null,
      folder_id: file.folderId,
      created_at: new Date(file.createdAt).toISOString(),
      updated_at: new Date(file.updatedAt).toISOString(),
      download_count: file.downloadCount,
    };
  }
}
