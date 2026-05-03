import {
  IsString,
  IsUrl,
  IsOptional,
  IsIn,
  IsBoolean,
  IsInt,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

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

  /** Drop imported media into this existing library. Mutually exclusive with newLibraryName. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetLibraryId?: number;

  /** Create a new library with this name and use it as the import target. */
  @IsOptional()
  @IsString()
  newLibraryName?: string;
}
