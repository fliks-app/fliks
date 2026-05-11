import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class DirectPlayProfile {
  @IsArray()
  @IsString({ each: true })
  containers: string[];

  @IsArray()
  @IsString({ each: true })
  videoCodecs: string[];

  @IsArray()
  @IsString({ each: true })
  audioCodecs: string[];
}

export class CodecCondition {
  @IsString()
  codec: string;

  @IsNumber()
  @IsOptional()
  maxLevel?: number;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  profiles?: string[];

  @IsNumber()
  @IsOptional()
  maxBitDepth?: number;

  @IsNumber()
  @IsOptional()
  maxWidth?: number;

  @IsNumber()
  @IsOptional()
  maxHeight?: number;
}

export class DeviceProfileDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DirectPlayProfile)
  directPlayProfiles: DirectPlayProfile[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CodecCondition)
  @IsOptional()
  codecConditions?: CodecCondition[];

  @IsNumber()
  @IsOptional()
  maxStreamingBitrate?: number;

  @IsNumber()
  @IsOptional()
  maxAudioChannels?: number;

  @IsBoolean()
  @IsOptional()
  supportsHdr?: boolean;

  @IsIn(['mobile', 'desktop'])
  @IsOptional()
  deviceType?: 'mobile' | 'desktop';

  /**
   * True when the request originates from a Chromecast sender. Drives the
   * HLS segment container choice: MPEG-TS instead of fMP4. TS avoids the
   * AAC/EAC3 encoder priming desync, because each audio packet in a TS
   * stream carries its own PTS and there's no init segment / edit-list
   * for the receiver to honour or ignore. fMP4 stays the default for web
   * (Shaka), native (ExoPlayer / AVPlayer) and TV.
   */
  @IsBoolean()
  @IsOptional()
  useTs?: boolean;
}
