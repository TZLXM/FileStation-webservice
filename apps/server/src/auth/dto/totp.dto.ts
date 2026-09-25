import { IsString, Length, Matches } from 'class-validator';

export class TotpCodeDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'TOTP code must be 6 digits' })
  code!: string;
}

export class TotpDisableDto {
  @IsString()
  @Length(1, 128)
  password!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'TOTP code must be 6 digits' })
  code!: string;
}

export class TotpLoginDto {
  @IsString()
  @Matches(/^ch_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  login_challenge!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'TOTP code must be 6 digits' })
  totp_code!: string;
}
