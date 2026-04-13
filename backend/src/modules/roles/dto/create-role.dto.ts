import { IsString, IsBoolean, IsArray, IsInt, IsOptional } from 'class-validator';

export class CreateRoleDto {
  @IsString()
  name: string;

  @IsArray()
  @IsString({ each: true })
  permissions: string[];

  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;

  /** Library IDs new users with this role inherit on creation. */
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  defaultLibraryIds?: number[];
}
