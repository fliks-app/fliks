import {
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsBoolean,
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
