import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
} from 'class-validator';
import type { GuideSourceKind } from '../entities/livetv-guide-source.entity';

export class CreateLiveTvGuideSourceDto {
  @IsString()
  name: string;

  @IsIn(['xmltv', 'source'])
  kind: GuideSourceKind;

  @IsOptional()
  @IsString()
  url?: string;

  /** Required when `kind: 'source'`: the Live TV source whose own guide to read. */
  @IsOptional()
  @IsInt()
  sourceId?: number;

  @IsOptional()
  @IsInt()
  refreshIntervalHours?: number;

  @IsOptional()
  @IsInt()
  timezoneOffsetMinutes?: number;

  /** Preferred `<title lang="...">` when a programme carries several. */
  @IsOptional()
  @IsString()
  language?: string;

  /** Higher wins when this feed and another define the same channel id. */
  @IsOptional()
  @IsInt()
  priority?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
