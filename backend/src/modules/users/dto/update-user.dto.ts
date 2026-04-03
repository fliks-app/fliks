import {
  IsString,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsEmail,
  MinLength,
  Min,
} from 'class-validator';

export class UpdateUserDto {
  @IsString()
  @IsOptional()
  username?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @MinLength(8)
  @IsOptional()
  password?: string;

  @IsNumber()
  @IsOptional()
  roleId?: number;

  @IsBoolean()
  @IsOptional()
  isAdmin?: boolean;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsNumber()
  @Min(0)
  @IsOptional()
  movieQuotaLimit?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  seriesQuotaLimit?: number;

  @IsNumber()
  @Min(1)
  @IsOptional()
  quotaPeriodDays?: number;
}
