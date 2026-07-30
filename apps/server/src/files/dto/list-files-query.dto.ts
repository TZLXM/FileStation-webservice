import { IsInt, Min, Max, IsOptional, IsUUID, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';

export class ListFilesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  page_size?: number = 20;

  // 'root' = 仅根目录（folder_id IS NULL）；uuid = 指定文件夹；缺省 = 全部
  @IsOptional()
  @ValidateIf((_obj, value) => value !== 'root')
  @IsUUID()
  folder_id?: string;
}
