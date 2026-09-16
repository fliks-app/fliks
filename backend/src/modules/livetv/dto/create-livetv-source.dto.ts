import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import type { LiveTvSourceKind } from '../entities/livetv-source.entity';

export class CreateLiveTvSourceDto {
  @IsString()
  name: string;

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
  @IsInt()
  @Min(0)
  maxStreams?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  refreshIntervalHours?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  priority?: number;

  @IsOptional()
  @IsString()
  includeGroupsPattern?: string;

  @IsOptional()
  @IsString()
  excludeGroupsPattern?: string;
}
