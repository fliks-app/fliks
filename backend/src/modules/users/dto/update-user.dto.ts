import {
  ArrayNotContains,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { ProfileVisibility } from '../../../common/enums';

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

  /** Self-editable: social profile discoverability (public / private). */
  @IsEnum(ProfileVisibility)
  @IsOptional()
  profileVisibility?: ProfileVisibility;

  /** Self-editable: expose derived top-genres on the public profile. */
  @IsBoolean()
  @IsOptional()
  shareTastes?: boolean;

  /** Self-editable: expose personal recommendations on the public profile. */
  @IsBoolean()
  @IsOptional()
  shareRecommendations?: boolean;

  /** Self-editable: expose recently-watched on the public profile. */
  @IsBoolean()
  @IsOptional()
  shareWatchHistory?: boolean;

  /** Self-editable: expose liked content on the public profile. */
  @IsBoolean()
  @IsOptional()
  shareLikes?: boolean;

  /** Self-editable: opt out of the whole social layer (undiscoverable + can't
   *  use sharing features). Enabling it drops the user's social ties. */
  @IsBoolean()
  @IsOptional()
  shareDisabled?: boolean;
}
