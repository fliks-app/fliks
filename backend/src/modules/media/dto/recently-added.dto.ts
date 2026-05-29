import { IsIn, IsBoolean, IsNumber, IsOptional } from 'class-validator';
import { Type, Transform } from 'class-transformer';

/**
 * Ranking basis for "recently added": by the media's own add time, by the
 * newest imported file, or by whichever of the two is more recent.
 */
export type RecentlyAddedMode = 'media' | 'file' | 'both';

export const RECENTLY_ADDED_MODES: RecentlyAddedMode[] = [
  'media',
  'file',
  'both',
];

export class RecentlyAddedDto {
  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  libraryId?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  limit?: number;

  @IsIn(RECENTLY_ADDED_MODES)
  @IsOptional()
  mode?: RecentlyAddedMode;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  excludeWatched?: boolean;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  requestedByMe?: boolean;
}
