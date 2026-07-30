import { IsString, Length, IsOptional, IsUUID, IsISO8601, ValidateIf } from 'class-validator';

export class UpdateFileDto {
  @IsOptional()
  @IsString()
  @Length(1, 255)
  filename?: string;

  // undefined = 不移动；null = 移回收件箱（根级）；string = 目标文件夹
  @ValidateIf((_obj, value) => value !== null && value !== undefined)
  @IsUUID()
  folder_id?: string | null;

  // undefined = 不修改；null = 永久保留；string = 新的 ISO 过期时间
  @ValidateIf((_obj, value) => value !== null && value !== undefined)
  @IsISO8601()
  expires_at?: string | null;
}
