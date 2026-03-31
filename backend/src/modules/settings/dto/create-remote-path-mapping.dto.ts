import { IsString, IsNumber, IsOptional } from 'class-validator';

export class CreateRemotePathMappingDto {
  @IsNumber()
  @IsOptional()
  downloadClientId?: number;

  @IsString()
  remotePath: string;

  @IsString()
  localPath: string;
}
