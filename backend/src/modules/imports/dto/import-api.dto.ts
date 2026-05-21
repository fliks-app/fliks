import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PathMappingDto {
  @IsString()
  remotePath: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  localLibraryId: number | null;

  @IsOptional()
  @IsBoolean()
  ignore?: boolean;
}

export class ImportApiDto {
  @IsUrl({ require_tld: false, require_protocol: true })
  url: string;

  @IsString()
  apiKey: string;

  /** 'skip' = only import new media, 'update' = import new + update existing fields */
  @IsOptional()
  @IsIn(['skip', 'update'])
  mode?: 'skip' | 'update';

  /** Import external subtitle files from Radarr/Sonarr */
  @IsOptional()
  @IsBoolean()
  importSubtitles?: boolean;

  /** Drop imported media into this existing library. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetLibraryId: number;

  /**
   * Maps each *arr remote root folder onto a Fliks library, or marks it
   * ignored. Required (can be empty when *arr exposes no roots). The
   * wizard step in the UI is the only place these are produced.
   */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PathMappingDto)
  pathMappings: PathMappingDto[];
}
