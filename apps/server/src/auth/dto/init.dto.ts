import { IsString, MinLength, MaxLength, Matches } from 'class-validator';

export class InitDto {
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'Username may only contain letters, digits, underscore and dash' })
  username!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  // init token 不在 body 中——通过 X-Init-Token 头传递（v1.6 修正）
}
