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

/**
 * Patch DTO. `userIds` is managed via the dedicated PUT :id/access endpoint.
 * `path` (singleton root folder) is updated through this DTO directly.
 */
export class UpdateLibraryDto {
  @IsOptional()
  @IsString()
  name?: string;

  /** Replace the library's root path. Empty string clears it. */
  @IsOptional()
  @IsString()
  path?: string;

  @IsOptional()
  @IsString()
  icon?: string | null;

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
}
