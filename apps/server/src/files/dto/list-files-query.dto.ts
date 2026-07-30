import { IsInt, Min, Max, IsOptional, IsUUID } from 'class-validator';
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

  @IsOptional()
  @IsUUID()
  folder_id?: string;
}
