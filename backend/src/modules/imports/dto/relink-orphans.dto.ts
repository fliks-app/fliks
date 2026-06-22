import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MediaType } from '../../../common/enums';

export class RelinkFileDto {
  @IsString()
  filePath: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  seasonNumber?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  episodeNumber?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  episodeEnd?: number;
}

export class RelinkOrphansDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  libraryId: number;

  @IsEnum(MediaType)
  type: MediaType;

  @IsString()
  externalId: string;

  @IsOptional()
  @IsString()
  provider?: string;

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

  /** On-disk folder (relative to the library root) the media is pinned to. */
  @IsString()
  folderName: string;

  /**
   * When true, move + rename the files into the library's naming layout
   * (reusing the disk-import pipeline) instead of linking them in place.
   */
  @IsOptional()
  @IsBoolean()
  reorganize?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RelinkFileDto)
  files: RelinkFileDto[];
}
