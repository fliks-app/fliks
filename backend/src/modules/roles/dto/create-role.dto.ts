import { IsString, IsBoolean, IsArray, IsOptional } from 'class-validator';

export class CreateRoleDto {
  @IsString()
  name: string;

  @IsArray()
  @IsString({ each: true })
  permissions: string[];

  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}
