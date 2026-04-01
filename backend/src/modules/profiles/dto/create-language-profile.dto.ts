import {
  IsString,
  IsBoolean,
  IsArray,
  ValidateNested,
  IsOptional,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AudioLanguageItemDto {
  @IsString()
  isoCode: string;

  @IsString()
  name: string;
}

export class SubtitleLanguageItemDto {
  @IsString()
  isoCode: string;

  @IsString()
  name: string;

  @IsBoolean()
  forced: boolean;

  @IsBoolean()
  hi: boolean;
}

export class CreateLanguageProfileDto {
  @IsString()
  name: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AudioLanguageItemDto)
  @IsOptional()
  audioLanguages?: AudioLanguageItemDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SubtitleLanguageItemDto)
  @IsOptional()
  subtitleLanguages?: SubtitleLanguageItemDto[];
}
