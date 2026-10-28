import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';

export class InstallUpdateDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  prepared_id!: string;

  @ApiProperty({ writeOnly: true })
  @IsString()
  @Length(1, 1024)
  password!: string;

  @ApiPropertyOptional({ description: 'Required when administrator TOTP is active' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/)
  totp_code?: string;
}
