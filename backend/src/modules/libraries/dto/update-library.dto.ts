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
 * Patch DTO. `paths` and `userIds` are managed via dedicated endpoints
 * (POST/DELETE :id/paths, PUT :id/access).
 */
export class UpdateLibraryDto {
  @IsOptional()
  @IsString()
  name?: string;

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
