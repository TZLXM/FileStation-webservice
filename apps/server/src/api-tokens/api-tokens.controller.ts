import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiResponse, ApiTokenInfo, ApiTokenScope, CreatedApiToken } from '@filestation/shared';
import { Request } from 'express';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { AdminOnlyGuard } from '../security/guards/admin-only.guard';
import { CreateApiTokenDto } from './dto/create-api-token.dto';
import { ApiTokensService } from './api-tokens.service';

@Controller('api-tokens')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
export class ApiTokensController {
  constructor(private apiTokensService: ApiTokensService) {}

  @Post()
  async create(@Body() body: CreateApiTokenDto, @Req() req: Request): Promise<ApiResponse<CreatedApiToken>> {
    const user = (req as any).user;
    const { record, plaintext } = await this.apiTokensService.createToken(
      user.id,
      body.name,
      body.scopes as ApiTokenScope[],
      body.expires_in_days ?? null,
    );
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
    return {
      code: 'OK',
      message: 'API token revoked',
      data: null,
      request_id: crypto.randomUUID(),
    };
  }
}
