import { IsString, Length, IsBoolean, IsInt, Min, Max, IsOptional, ValidateIf, ValidateNested, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

export class SiteSettingsDto {
  @IsOptional() @IsString() @Length(1, 64)
  name?: string;

  @ValidateIf((_o, v) => v !== undefined && v !== null)
  @IsString() @Length(1, 256)
  icon?: string | null;

  @IsOptional() @IsString() @Length(4, 32)
  theme_color?: string;
}

export class SecuritySettingsDto {
  // Phase 1 决策：DTO 层直接拒绝写入 totp_required=true（未实现，防安全功能假开启）
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn([false], { message: 'security.totp_required is not supported in Phase 1 and cannot be written' })
  totp_required?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20)
  max_login_attempts?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1440)
  lockout_minutes?: number;
}

export class TransferSettingsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(64 * 1024) @Max(64 * 1024 * 1024)
  default_chunk_size?: number;

  @ValidateIf((_o, v) => v !== undefined && v !== null)
  @Type(() => Number) @IsInt() @Min(1024)
  global_upload_limit_bps?: number | null;

  @ValidateIf((_o, v) => v !== undefined && v !== null)
  @Type(() => Number) @IsInt() @Min(1024)
  global_download_limit_bps?: number | null;
}

export class StorageSettingsDto {
  // path 不可写：DTO 不声明 path 字段，whitelist+forbidNonWhitelisted 会在带 path 时直接 400
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10240)
  max_size_gb?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(720)
  cleanup_grace_hours?: number;

  // 语义：0 = 永久保留（存 null），>0 = 小时数
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(87600)
  default_expire_hours?: number;
}

export class AgentSettingsDto {
  @IsOptional() @IsBoolean()
  mcp_enabled?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(512)
  mcp_max_upload_mb?: number;
}

export class UpdateSettingsDto {
  @IsOptional() @ValidateNested() @Type(() => SiteSettingsDto)
  site?: SiteSettingsDto;

  @IsOptional() @ValidateNested() @Type(() => SecuritySettingsDto)
  security?: SecuritySettingsDto;

  @IsOptional() @ValidateNested() @Type(() => TransferSettingsDto)
  transfer?: TransferSettingsDto;

  @IsOptional() @ValidateNested() @Type(() => StorageSettingsDto)
  storage?: StorageSettingsDto;

  @IsOptional() @ValidateNested() @Type(() => AgentSettingsDto)
  agent?: AgentSettingsDto;
}
