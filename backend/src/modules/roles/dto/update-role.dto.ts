import { IsString, IsBoolean, IsArray, IsOptional } from 'class-validator';

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
}
