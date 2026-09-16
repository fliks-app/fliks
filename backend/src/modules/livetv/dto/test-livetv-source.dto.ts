import { IsIn, IsOptional, IsString } from 'class-validator';
import type { LiveTvSourceKind } from '../entities/livetv-source.entity';

/** Probes a URL or Xtream login without persisting anything. */
export class TestLiveTvSourceDto {
  @IsIn(['m3u', 'xtream'])
  kind: LiveTvSourceKind;

  @IsString()
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
