import {
  IsString,
  IsBoolean,
  IsArray,
  ValidateNested,
  IsOptional,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { HearingImpairedMode } from '../entities/language-profile.entity';

const HI_MODES: HearingImpairedMode[] = ['prefer', 'avoid', 'require', 'forbid'];

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

  @IsIn(HI_MODES)
  @IsOptional()
  hearingImpaired?: HearingImpairedMode;
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
