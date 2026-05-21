import { IsEnum, IsString, IsOptional, IsInt, Min } from 'class-validator';
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
}
