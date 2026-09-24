import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import type { LiveTvSourceKind } from '../entities/livetv-source.entity';
import { IsPlaylistLocation } from './playlist-location.validator';

/** Probes a URL or Xtream login without persisting anything. */
export class TestLiveTvSourceDto {
  /** Names the saved source being re-tested, so its stored password can be
   *  used in place of the blank the client's edit form always shows. */
  @IsOptional()
  @IsInt()
  @Min(1)
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
