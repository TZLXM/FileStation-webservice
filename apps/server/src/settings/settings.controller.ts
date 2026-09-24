import { Controller, Get, Put, Body, UseGuards, Req } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { JwtAuthGuard } from '../security/guards/jwt-auth.guard';
import { AdminOnlyGuard } from '../security/guards/admin-only.guard';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { ApiResponse } from '@filestation/shared';
import { Request } from 'express';
import { AuditAction, AuditService } from '../audit/audit.service';

/** 剔除 undefined 字段（ES2022 useDefineForClassFields 下 DTO 类字段会成为值为 undefined 的自有属性，
 *  直接 spread 会用 undefined 覆盖已有值 —— 必须先清洗再合并） */
function omitUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function hasChangedKeys(current: object, updates: object): boolean {
  const currentValues = current as Record<string, unknown>;
  return Object.entries(updates).some(([key, value]) => currentValues[key] !== value);
}

@Controller('settings')
export class SettingsController {
  constructor(private settingsService: SettingsService, private auditService: AuditService) {}

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
    const updatedSections: string[] = [];

    // 合并更新：读取后合并（经 omitUndefined 清洗），非覆盖
    if (body.site) {
      const updates = omitUndefined(body.site);
      if (Object.keys(updates).length > 0) {
        const current = await this.settingsService.getSiteSettings();
        const changed = hasChangedKeys(current, updates);
        await this.settingsService.set('site', { ...current, ...updates }, userId);
        if (changed) updatedSections.push('site');
      }
    }
    if (body.security) {
      const updates = omitUndefined(body.security);
      if (Object.keys(updates).length > 0) {
        const current = await this.settingsService.getSecuritySettings();
        const changed = hasChangedKeys(current, updates);
        await this.settingsService.set('security', { ...current, ...updates }, userId);
        if (changed) updatedSections.push('security');
      }
    }
    if (body.transfer) {
      const updates = omitUndefined(body.transfer);
      if (Object.keys(updates).length > 0) {
        const current = await this.settingsService.getTransferSettings();
        const changed = hasChangedKeys(current, updates);
        await this.settingsService.set('transfer', { ...current, ...updates }, userId);
        if (changed) updatedSections.push('transfer');
      }
    }
    if (body.storage) {
      const updates = omitUndefined(body.storage);
      if (Object.keys(updates).length > 0) {
        const current = await this.settingsService.getStorageSettings();
        const changed = hasChangedKeys(current, updates);
        // body.storage 已不含 path（DTO 拒绝）；合并后 path 保持 ConfigService 实际值（不入库）
        const { path: _actualPath, ...rest } = current;
        await this.settingsService.set('storage', { ...rest, ...updates }, userId);
        if (changed) updatedSections.push('storage');
      }
    }

    if (updatedSections.length > 0) {
      await this.auditService.record({
        accountId: userId,
        action: AuditAction.SETTINGS_UPDATED,
        details: { sections: updatedSections },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
    }

    return { code: 'OK', message: 'Settings updated', data: null, request_id: crypto.randomUUID() };
  }
}
