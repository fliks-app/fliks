import {
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsBoolean,
  IsArray,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { MediaType, MediaStatus } from '../../../common/enums';

export class SearchMediaDto {
  @IsString()
  @IsOptional()
  q?: string;

  @IsEnum(MediaType)
  @IsOptional()
  type?: MediaType;

  @IsEnum(MediaStatus)
  @IsOptional()
  status?: MediaStatus;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  monitored?: boolean;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  year?: number;

  @IsString()
  @IsOptional()
  genre?: string;

  /**
   * Multi-genre filter matched by name. Accepts a comma-joined string (as sent
   * by the search panel) or an array; all listed genres must be present
   * (AND semantics).
   */
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value)) {
      return value.map((v: string) => String(v).trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    }
    return value;
  })
  genres?: string[];

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  yearMin?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  yearMax?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  voteMin?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  collectionId?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  qualityProfileId?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  languageProfileId?: number;

  @IsString()
  @IsOptional()
  sortBy?: string;

  @IsString()
  @IsOptional()
  sortOrder?: 'ASC' | 'DESC';

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  page?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  limit?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  libraryId?: number;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  missing?: boolean;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  cutoffUnmet?: boolean;

  @IsString()
  @IsOptional()
  letter?: string;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  excludeWatched?: boolean;

  /** Inverse of `excludeWatched` — only return media the current user has
   *  finished. Mutually exclusive in practice (UI exposes a tri-state). */
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  onlyWatched?: boolean;

  /** Only return media that the current user requested (via the requests system). */
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  requestedByMe?: boolean;
}
