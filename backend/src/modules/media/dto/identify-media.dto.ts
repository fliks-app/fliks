import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** At least one id is required; the service refuses an empty target. The ids
 *  sent are the media's new identity — an omitted one is cleared, not kept. */
export class IdentifyMediaDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  tmdbId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  tvdbId?: number;

  @IsOptional()
  @IsString()
  imdbId?: string;

  @IsOptional()
  @IsString()
  preferredProvider?: string;
}
