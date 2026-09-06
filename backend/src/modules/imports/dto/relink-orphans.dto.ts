import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
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

  @IsOptional()
  @IsString()
  externalId?: string;

  @IsOptional()
  @IsString()
  provider?: string;

  /** Used only when `externalId` is absent, to create an unmatched title. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1888)
  @Max(2100)
  year?: number;

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
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RelinkFileDto)
  files: RelinkFileDto[];
}
