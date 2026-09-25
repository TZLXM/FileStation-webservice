import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RecoveryGenerateDto {
  @ApiProperty({ minLength: 1, maxLength: 128, description: 'Current administrator password' })
  @IsString()
  @Length(1, 128)
  password!: string;

  @ApiPropertyOptional({ pattern: '^\\d{6}$', description: 'Required when TOTP is enabled' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/)
  totp_code?: string;
}

export class RecoveryVerifyDto {
  @ApiProperty({ minLength: 1, maxLength: 64, description: 'Administrator username' })
  @IsString()
  @Length(1, 64)
  username!: string;

  @ApiProperty({ minLength: 1, maxLength: 32, description: 'Single-use recovery code' })
  @IsString()
  @Length(1, 32)
  code!: string;
}

export class RecoveryGenerateDataDto {
  @ApiProperty({ type: [String], description: 'Shown once; save these codes securely' })
  codes!: string[];
}

export class RecoveryGenerateResponseDto {
  @ApiProperty({ example: 'OK' })
  code!: string;

  @ApiProperty({ example: 'Recovery codes generated; save them now' })
  message!: string;

  @ApiProperty({ type: RecoveryGenerateDataDto })
  data!: RecoveryGenerateDataDto;

  @ApiProperty({ format: 'uuid' })
  request_id!: string;
}

export class RecoveryVerifyDataDto {
  @ApiProperty({ format: 'jwt', description: 'Short-lived administrator access token' })
  access_token!: string;

  @ApiProperty({ example: 86400, description: 'Access-token lifetime in seconds' })
  expires_in!: number;

  @ApiProperty({ description: 'Administrator username' })
  username!: string;
}

export class RecoveryVerifyResponseDto {
  @ApiProperty({ example: 'OK' })
  code!: string;

  @ApiProperty({ example: 'Recovery successful' })
  message!: string;

  @ApiProperty({ type: RecoveryVerifyDataDto })
  data!: RecoveryVerifyDataDto;

  @ApiProperty({ format: 'uuid' })
  request_id!: string;
}
