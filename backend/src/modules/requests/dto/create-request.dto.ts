import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MediaType } from '../../../common/enums';

export class CreateRequestDto {
  @IsEnum(MediaType)
  mediaType: MediaType;

  @IsInt()
  @Min(1)
  tmdbId: number;

  @IsString()
  title: string;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  seasons?: number[];

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  qualityProfileId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  languageProfileId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  libraryId?: number;
}
