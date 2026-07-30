import { IsUUID, IsIn, IsString, MinLength, ValidateIf, IsInt, Min, IsISO8601 } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateShareDto {
  @IsUUID()
  file_id!: string;

  @IsIn(['none', 'password'], { message: 'Phase 1 only supports none/password protection' })
  protection!: 'none' | 'password';

  // protection === 'password' 时必填；'none' 时忽略
  @ValidateIf((obj: CreateShareDto) => obj.protection === 'password')
  @IsString()
  @MinLength(4)
  password?: string;

  // DTO 层禁止 0（根治 v1.5 body.max_downloads||null 把 0 变无限制）
  @ValidateIf((_obj, value) => value !== undefined && value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  max_downloads?: number;

  @ValidateIf((_obj, value) => value !== undefined && value !== null)
  @IsISO8601()
  expires_at?: string;
}
