import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { API_TOKEN_SCOPES } from '@filestation/shared';

export class CreateApiTokenDto {
  @IsString()
  @Length(1, 64)
  name!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsIn(API_TOKEN_SCOPES as unknown as string[], { each: true })
  scopes!: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  expires_in_days?: number;
}
