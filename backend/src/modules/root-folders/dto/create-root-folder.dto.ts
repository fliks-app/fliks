import { IsString, IsOptional } from 'class-validator';

export class CreateRootFolderDto {
  @IsString()
  path: string;

  @IsString()
  @IsOptional()
  label?: string;
}
