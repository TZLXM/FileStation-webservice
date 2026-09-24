import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiResponse, AuditLogEntry, PaginatedResponse } from '@filestation/shared';
import { AdminOnlyGuard } from '../security/guards/admin-only.guard';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';
import { AuditService } from './audit.service';

@Controller('audit-logs')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  async list(@Query() query: ListAuditLogsDto): Promise<ApiResponse<PaginatedResponse<AuditLogEntry>>> {
    const result = await this.auditService.findAll(query.page ?? 1, query.page_size ?? 20, query.action);
    return { code: 'OK', message: 'Success', data: result, request_id: crypto.randomUUID() };
  }
}
