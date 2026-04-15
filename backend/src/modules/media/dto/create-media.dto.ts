import {
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsBoolean,
  IsArray,
  IsDateString,
} from 'class-validator';
import { MediaType, MediaStatus } from '../../../common/enums';

export class CreateMediaDto {
  @IsString()
  title: string;

  @IsString()
  @IsOptional()
  originalTitle?: string;

  @IsNumber()
  @IsOptional()
  year?: number;

  @IsEnum(MediaType)
  type: MediaType;

  @IsNumber()
  @IsOptional()
  tmdbId?: number;

  @IsString()
  @IsOptional()
  imdbId?: string;

  @IsString()
  @IsOptional()
  overview?: string;

  @IsEnum(MediaStatus)
  @IsOptional()
  status?: MediaStatus;

  @IsBoolean()
  @IsOptional()
  monitored?: boolean;

  @IsString()
  @IsOptional()
  path?: string;

  @IsString()
  @IsOptional()
  posterUrl?: string;

  @IsString()
  @IsOptional()
  fanartUrl?: string;

  @IsNumber()
  @IsOptional()
  rating?: number;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  genres?: string[];

  @IsNumber()
  @IsOptional()
  runtime?: number;

  @IsDateString()
  @IsOptional()
  releaseDate?: string;

  @IsNumber()
  @IsOptional()
  qualityProfileId?: number;

  @IsNumber()
  @IsOptional()
  languageProfileId?: number;

}
