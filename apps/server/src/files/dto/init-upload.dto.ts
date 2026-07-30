import { IsString, Length, IsInt, Min, Max, IsOptional, Matches, IsUUID } from 'class-validator';
import { Type } from 'class-transformer';

export const MAX_FILE_SIZE = 100 * 1024 * 1024 * 1024; // 100 GiB
export const MIN_CHUNK_SIZE = 64 * 1024;   // 64 KiB
export const MAX_CHUNK_SIZE = 64 * 1024 * 1024; // 64 MiB
export const SHA256_HEX = /^[a-f0-9]{64}$/;

export class InitUploadDto {
  @IsString()
  @Length(1, 255)
  filename!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_FILE_SIZE)
  size!: number;

  @IsOptional()
  @IsString()
  @Matches(SHA256_HEX, { message: 'hash must be a lowercase sha256 hex digest' })
  hash?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_CHUNK_SIZE)
  @Max(MAX_CHUNK_SIZE)
  chunk_size?: number;

  // 上传到指定文件夹；缺省 = 收件箱（根级）
  @IsOptional()
  @IsUUID()
  folder_id?: string;
}
