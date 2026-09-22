import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** Matches the service's own `Math.min(pageSize, DEFAULT_PAGE_SIZE)` cap, so the client sees it. */
const MAX_PAGE_SIZE = 50;
const MAX_QUERY_LENGTH = 200;

/** `on-now` is `channels` with a live/next overlay: same group/query filters. */
export class LiveTvOnNowQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_QUERY_LENGTH)
  group?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_QUERY_LENGTH)
  query?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize?: number;
}

export class LiveTvSearchQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_QUERY_LENGTH)
  q?: string;
}

export class LiveTvMatchReportQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  guideSourceId?: number;
}
