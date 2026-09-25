import { IsOptional, IsString, Length, Matches } from 'class-validator';

export class RecoveryGenerateDto {
  @IsString()
  @Length(1, 128)
  password!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/)
  totp_code?: string;
}

export class RecoveryVerifyDto {
  @IsString()
  @Length(1, 64)
  username!: string;

  @IsString()
  @Length(1, 32)
  code!: string;
}
