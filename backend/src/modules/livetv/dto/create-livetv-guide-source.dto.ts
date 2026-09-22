import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
} from 'class-validator';
import type { GuideSourceKind } from '../entities/livetv-guide-source.entity';

export class CreateLiveTvGuideSourceDto {
  @IsString()
  name: string;

  @IsIn(['xmltv', 'source'])
  kind: GuideSourceKind;

  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
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
