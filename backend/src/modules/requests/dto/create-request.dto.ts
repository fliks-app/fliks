import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MediaType, RequestKind } from '../../../common/enums';

export class CreateRequestDto {
  @IsEnum(MediaType)
  mediaType: MediaType;

  /** Whether to add the title or delete an existing library title.
   *  Defaults to an add request when omitted. */
  @IsOptional()
  @IsEnum(RequestKind)
  kind?: RequestKind;

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
