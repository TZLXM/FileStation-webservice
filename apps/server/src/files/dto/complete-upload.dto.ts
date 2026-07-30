import { IsOptional, IsString, Matches } from 'class-validator';
import { SHA256_HEX } from './init-upload.dto';

export class CompleteUploadDto {
  @IsOptional()
  @IsString()
  @Matches(SHA256_HEX, { message: 'final_hash must be a lowercase sha256 hex digest' })
  final_hash?: string;
}
