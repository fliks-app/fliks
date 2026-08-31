import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import type { RemoteCommandAction } from '../../scheduler/events.service';

/** Kept in sync with the `RemoteCommandAction` union in `events.service.ts`. */
export const REMOTE_COMMAND_ACTIONS: RemoteCommandAction[] = [
  'load',
  'play',
  'pause',
  'playpause',
  'stop',
  'seek',
  'volume',
  'mute',
  'next',
  'audio',
  'subtitle',
  'quality',
];

/** Every field is absolute / state-setting, never a delta: see `RemoteCommandAction`. */
export class RemoteCommandDto {
  @IsIn(REMOTE_COMMAND_ACTIONS)
  action: RemoteCommandAction;

  @IsInt()
  @IsOptional()
  mediaId?: number;

  @IsInt()
  @IsOptional()
  mediaFileId?: number;

  @IsInt()
  @IsOptional()
  episodeId?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  positionSeconds?: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  @IsOptional()
  level?: number;

  @IsBoolean()
  @IsOptional()
  muted?: boolean;

  @IsString()
  @IsOptional()
  trackId?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  subtitleId?: string | null;

  @IsString()
  @IsOptional()
  qualityId?: string;

  /** The issuing controller's own target id: attribution and the self-target guard. */
  @IsString()
  @IsOptional()
  byTargetId?: string;
}
