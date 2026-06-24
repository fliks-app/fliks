import {
  ArrayNotContains,
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
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

  /** Admin-only: forces the user to set a new password before reaching the app. */
  @IsBoolean()
  @IsOptional()
  requirePasswordChange?: boolean;

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

  /** Full replacement list of libraries the user has access to. */
  @IsArray()
  @IsInt({ each: true })
  @ArrayNotContains([0])
  @IsOptional()
  libraryIds?: number[];

  /** Self-editable: preferred library display order (library ids, first to last). */
  @IsArray()
  @IsInt({ each: true })
  @IsOptional()
  libraryOrder?: number[];

  /** Self-editable: library ids to hide from the home page and sidebar. */
  @IsArray()
  @IsInt({ each: true })
  @IsOptional()
  hiddenLibraryIds?: number[];
}
