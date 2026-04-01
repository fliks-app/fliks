import { IsString, IsOptional } from 'class-validator';

export class UpdateRootFolderDto {
  @IsString()
  @IsOptional()
  path?: string;

  @IsString()
  @IsOptional()
  label?: string;
}
