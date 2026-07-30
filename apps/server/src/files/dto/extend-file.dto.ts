import { IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class ExtendFileDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(87600) // 最长延 10 年
  hours!: number;
}
