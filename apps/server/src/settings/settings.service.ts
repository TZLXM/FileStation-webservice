import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Setting } from './entities/setting.entity';

export interface SiteSettings {
  name: string;
  icon: string | null;
  theme_color: string;
}

export interface SecuritySettings {
  totp_required: boolean;
  max_login_attempts: number;
  lockout_minutes: number;
}

export interface TransferSettings {
  default_chunk_size: number;
  global_upload_limit_bps: number | null;
  global_download_limit_bps: number | null;
}

export interface StorageSettings {
  path: string;
  max_size_gb: number;
  cleanup_grace_hours: number;
  default_expire_hours: number;
}

export interface AgentSettings {
  mcp_enabled: boolean;
  mcp_max_upload_mb: number;
}

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(Setting)
    private settingsRepository: Repository<Setting>,
    private configService: ConfigService,
  ) {}

  async get<T>(key: string, defaultValue: T): Promise<T> {
    const setting = await this.settingsRepository.findOne({ where: { key } });
    if (!setting) return defaultValue;
    return JSON.parse(setting.value) as T;
  }

  async set<T>(key: string, value: T, updatedBy?: string): Promise<void> {
    await this.settingsRepository.save({
      key,
      value: JSON.stringify(value),
      updatedAt: Date.now(),
      updatedBy: updatedBy || null,
    });
  }

  async getSiteSettings(): Promise<SiteSettings> {
    return this.get<SiteSettings>('site', {
      name: 'FileStation',
      icon: null,
      theme_color: '#3b82f6',
    });
  }

  async getSecuritySettings(): Promise<SecuritySettings> {
    return this.get<SecuritySettings>('security', {
      totp_required: false,
      max_login_attempts: 5,
      lockout_minutes: 15,
    });
  }

  async getTransferSettings(): Promise<TransferSettings> {
    return this.get<TransferSettings>('transfer', {
      default_chunk_size: 8 * 1024 * 1024,
      global_upload_limit_bps: null,
      global_download_limit_bps: null,
    });
  }

  async getStorageSettings(): Promise<StorageSettings> {
    const stored = await this.get<Omit<StorageSettings, 'path'>>('storage', {
      max_size_gb: 100,
      cleanup_grace_hours: 24,
      default_expire_hours: 24,
    });
    return {
      ...stored,
      // 负值归一（兼容旧库 -1 "永久" 语义 → 0）
      default_expire_hours: Math.max(0, stored.default_expire_hours),
      // path 只读展示：始终返回环境变量/配置的实际值，不读库、不可写
      path: this.configService.get<string>('app.storagePath') || './data/storage',
    };
  }

  async getAgentSettings(): Promise<AgentSettings> {
    return this.get<AgentSettings>('agent', { mcp_enabled: false, mcp_max_upload_mb: 32 });
  }
}
