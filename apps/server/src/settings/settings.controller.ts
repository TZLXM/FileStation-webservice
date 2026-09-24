import { Controller, Get, Put, Body, UseGuards, Req } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { AdminOnlyGuard } from '../security/guards/admin-only.guard';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { ApiResponse } from '@filestation/shared';
import { Request } from 'express';

/** 剔除 undefined 字段（ES2022 useDefineForClassFields 下 DTO 类字段会成为值为 undefined 的自有属性，
 *  直接 spread 会用 undefined 覆盖已有值 —— 必须先清洗再合并） */
function omitUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

@Controller('settings')
export class SettingsController {
  constructor(private settingsService: SettingsService) {}

  @Get()
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  async getAll(): Promise<ApiResponse<any>> {
    const [site, security, transfer, storage] = await Promise.all([
      this.settingsService.getSiteSettings(),
      this.settingsService.getSecuritySettings(),
      this.settingsService.getTransferSettings(),
      this.settingsService.getStorageSettings(),
    ]);
    return { code: 'OK', message: 'Settings retrieved', data: { site, security, transfer, storage }, request_id: crypto.randomUUID() };
  }

  @Get('public')
  async getPublic(): Promise<ApiResponse<{ name: string; icon: string | null }>> {
    const site = await this.settingsService.getSiteSettings();
    return { code: 'OK', message: 'Public settings retrieved', data: { name: site.name, icon: site.icon }, request_id: crypto.randomUUID() };
  }

  @Put()
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  async update(@Body() body: UpdateSettingsDto, @Req() req: Request): Promise<ApiResponse<null>> {
    const userId = (req as any).user.id;

    // 合并更新：读取后合并（经 omitUndefined 清洗），非覆盖
    if (body.site) {
      const current = await this.settingsService.getSiteSettings();
      await this.settingsService.set('site', { ...current, ...omitUndefined(body.site) }, userId);
    }
    if (body.security) {
      const current = await this.settingsService.getSecuritySettings();
      await this.settingsService.set('security', { ...current, ...omitUndefined(body.security) }, userId);
    }
    if (body.transfer) {
      const current = await this.settingsService.getTransferSettings();
      await this.settingsService.set('transfer', { ...current, ...omitUndefined(body.transfer) }, userId);
    }
    if (body.storage) {
      const current = await this.settingsService.getStorageSettings();
      // body.storage 已不含 path（DTO 拒绝）；合并后 path 保持 ConfigService 实际值（不入库）
      const { path: _actualPath, ...rest } = current;
      await this.settingsService.set('storage', { ...rest, ...omitUndefined(body.storage) }, userId);
    }

    return { code: 'OK', message: 'Settings updated', data: null, request_id: crypto.randomUUID() };
  }
}
