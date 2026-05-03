import {
  IsString,
  IsNumber,
  IsArray,
  IsBoolean,
  IsOptional,
  ValidateNested,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Supported specification implementations:
 *   title_regex   — regex tested against the release title
 *   source        — matches source tag (bluray, web-dl, webrip, hdtv, dvd, cam)
 *   resolution    — matches resolution tag (2160p, 1080p, 720p, 480p, etc.)
 *   language      — matches detected language tag in release title
 */
class SpecificationDto {
  @IsString()
  name: string;

  @IsIn(['title_regex', 'source', 'resolution', 'language'])
  implementation: string;

  @IsBoolean()
  @IsOptional()
  negate?: boolean;

  @IsBoolean()
  @IsOptional()
  required?: boolean;

  @IsString()
  value: string;
}

export class CreateCustomFormatDto {
  @IsString()
  name: string;

  @IsNumber()
  @IsOptional()
  score?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SpecificationDto)
  @IsOptional()
  specifications?: SpecificationDto[];
}
