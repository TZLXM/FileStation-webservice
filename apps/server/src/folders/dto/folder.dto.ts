import { IsString, Length, IsOptional, IsUUID, ValidateIf } from 'class-validator';

export class CreateFolderDto {
  @IsString()
  @Length(1, 255)
  name!: string;

  @IsOptional()
  @IsUUID()
  parent_id?: string; // 缺省 = 根级
}

export class UpdateFolderDto {
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;

  // undefined = 不移动；null = 移到根级；string = 目标父文件夹
  @ValidateIf((_obj, value) => value !== null && value !== undefined)
  @IsUUID()
  parent_id?: string | null;
}
