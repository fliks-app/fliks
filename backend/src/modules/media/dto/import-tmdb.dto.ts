import { IsEnum, IsInt, IsNumber, Min, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { MediaType } from '../../../common/enums';

export class ImportTmdbDto {
  @IsEnum(MediaType)
  type: MediaType;

  @Type(() => Number)
  @IsNumber()
  @IsInt()
  @Min(1)
  tmdbId: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsInt()
  @Min(1)
  qualityProfileId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsInt()
  @Min(1)
  languageProfileId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsInt()
  @Min(1)
  libraryId?: number;
}
