import { IsOptional, IsString } from 'class-validator';

export class ShareAccessDto {
  @IsOptional()
  @IsString()
  password?: string;
}
