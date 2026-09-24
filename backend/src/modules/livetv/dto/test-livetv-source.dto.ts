import { IsIn, IsInt, IsOptional, IsString } from 'class-validator';
import type { LiveTvSourceKind } from '../entities/livetv-source.entity';
import { IsPlaylistLocation } from './playlist-location.validator';

/** Probes a URL or Xtream login without persisting anything. */
export class TestLiveTvSourceDto {
  /** The saved source being re-tested, if any: lets a blank secret field below
   *  resolve to its stored value instead of failing the probe outright. */
  @IsOptional()
  @IsInt()
  id?: number;

  @IsIn(['m3u', 'xtream'])
  kind: LiveTvSourceKind;

  @IsPlaylistLocation()
  url: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  userAgent?: string;

  @IsOptional()
  @IsString()
  referer?: string;

  @IsOptional()
  @IsString()
  includeGroupsPattern?: string;

  @IsOptional()
  @IsString()
  excludeGroupsPattern?: string;
}
