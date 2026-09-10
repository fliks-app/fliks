import {
  IsEnum,
  IsString,
  IsOptional,
  IsInt,
  IsArray,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MediaType } from '../../../common/enums';

export class ImportMediaDto {
  @IsEnum(MediaType)
  type: MediaType;

  @IsString()
  externalId: string;

  @IsString()
  @IsOptional()
  provider?: string; // 'tmdb' | 'tvdb', defaults to 'tmdb'

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qualityProfileId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  languageProfileId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  libraryId?: number;

  /** Series only: the seasons to monitor. Absent or empty monitors every season
   *  but the specials. Season 0 is only ever monitored by number. */
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(0, { each: true })
  monitoredSeasons?: number[];
}
