import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
} from 'class-validator';
import { MediaType } from '../../../common/enums/media-type.enum';
import {
  STALLED_CLEANUP_PROFILE_KEYS,
  StalledCleanupProfileKey,
} from '../../../common/constants/stalled-cleanup-profiles';

export class CreateLibraryDto {
  @IsString()
  name: string;

  /** Lucide icon name (e.g. 'film', 'tv', 'book'). */
  @IsOptional()
  @IsString()
  icon?: string | null;

  /** CSS color for home page card (e.g. 'primary', '#e74c3c'). */
  @IsOptional()
  @IsString()
  color?: string | null;

  @IsOptional()
  @IsArray()
  @IsEnum(MediaType, { each: true })
  mediaTypes?: MediaType[];

  @IsOptional()
  @IsString()
  preferredProvider?: string | null;

  @IsOptional()
  @IsIn([...STALLED_CLEANUP_PROFILE_KEYS, null])
  stalledCleanupProfile?: StalledCleanupProfileKey | null;

  @IsOptional()
  @IsInt()
  defaultQualityProfileId?: number | null;

  @IsOptional()
  @IsInt()
  defaultLanguageProfileId?: number | null;

  @IsOptional()
  @IsBoolean()
  isDefaultForMovies?: boolean;

  @IsOptional()
  @IsBoolean()
  isDefaultForSeries?: boolean;

  /** Initial root paths to attach to the library. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  paths?: string[];

  /** Initial set of users granted access. Admins always have access. */
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  userIds?: number[];
}
