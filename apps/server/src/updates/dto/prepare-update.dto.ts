import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class PrepareUpdateDto {
  @ApiProperty({ example: '0.2.5' })
  @IsString()
  @Matches(/^\d+\.\d+\.\d+$/)
  version!: string;

  @ApiProperty({ description: 'SHA-256 of the verified signed manifest' })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  manifest_sha256!: string;

  @ApiProperty({ description: 'SHA-256 of the selected signed artifact' })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  artifact_sha256!: string;
}
