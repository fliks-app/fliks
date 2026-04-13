import { IsString, IsBoolean, IsArray, IsInt, IsOptional } from 'class-validator';

export class UpdateRoleDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  permissions?: string[];

  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  defaultLibraryIds?: number[];
}
