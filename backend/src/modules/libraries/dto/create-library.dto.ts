import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
} from 'class-validator';
import { MediaType } from '../../../common/enums/media-type.enum';

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

  /** ISO 639-1 override; null inherits the global metadata language. */
  @IsOptional()
  @IsString()
  metadataLanguage?: string | null;

  /** ISO 3166-1 override; null inherits the global metadata region. */
  @IsOptional()
  @IsString()
  metadataRegion?: string | null;

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

  /** Initial root path. Optional — admin can attach it later via update. */
  @IsOptional()
  @IsString()
  path?: string;

  /** Initial set of users granted access. Admins always have access. */
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  userIds?: number[];
}
