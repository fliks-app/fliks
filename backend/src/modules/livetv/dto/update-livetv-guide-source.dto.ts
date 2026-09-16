import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
} from 'class-validator';
import type { GuideSourceKind } from '../entities/livetv-guide-source.entity';

export class UpdateLiveTvGuideSourceDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsIn(['xmltv', 'source'])
  kind?: GuideSourceKind;

  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsInt()
  sourceId?: number;

  @IsOptional()
  @IsInt()
  refreshIntervalHours?: number;

  @IsOptional()
  @IsInt()
  timezoneOffsetMinutes?: number;

  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsInt()
  priority?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
