import { IsString, IsUrl, IsOptional, IsIn, IsBoolean } from 'class-validator';

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
}
