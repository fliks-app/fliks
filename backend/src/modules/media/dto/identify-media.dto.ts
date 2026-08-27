import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** At least one id is required; the service refuses an empty target. An omitted
 *  field leaves the media's current value alone. */
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
