import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiResponse, ApiTokenInfo, ApiTokenScope, CreatedApiToken } from '@filestation/shared';
import { Request } from 'express';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { AdminOnlyGuard } from '../security/guards/admin-only.guard';
import { CreateApiTokenDto } from './dto/create-api-token.dto';
import { ApiTokensService } from './api-tokens.service';
import { AuditAction, AuditService } from '../audit/audit.service';

@Controller('api-tokens')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
export class ApiTokensController {
  constructor(private apiTokensService: ApiTokensService, private auditService: AuditService) {}

  @Post()
  async create(@Body() body: CreateApiTokenDto, @Req() req: Request): Promise<ApiResponse<CreatedApiToken>> {
    const user = (req as any).user;
    const { record, plaintext } = await this.apiTokensService.createToken(
      user.id,
      body.name,
      body.scopes as ApiTokenScope[],
      body.expires_in_days ?? null,
    );
    await this.auditService.record({
      accountId: user.id,
      action: AuditAction.API_TOKEN_CREATED,
      resourceType: 'api_token',
      resourceId: record.id,
      details: { name: body.name, scopes: body.scopes },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return {
      code: 'OK',
      message: 'API token created (shown once)',
      data: { ...record, token: plaintext },
      request_id: crypto.randomUUID(),
    };
  }

  @Get()
  async list(@Req() req: Request): Promise<ApiResponse<ApiTokenInfo[]>> {
    const user = (req as any).user;
    return {
      code: 'OK',
      message: 'Success',
      data: await this.apiTokensService.listTokens(user.id),
      request_id: crypto.randomUUID(),
    };
  }

  @Delete(':id')
  async revoke(@Param('id') id: string, @Req() req: Request): Promise<ApiResponse<null>> {
    const user = (req as any).user;
    await this.apiTokensService.revokeToken(user.id, id);
    await this.auditService.record({
      accountId: user.id,
      action: AuditAction.API_TOKEN_REVOKED,
      resourceType: 'api_token',
      resourceId: id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return {
      code: 'OK',
      message: 'API token revoked',
      data: null,
      request_id: crypto.randomUUID(),
    };
  }
}
