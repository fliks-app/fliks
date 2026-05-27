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

  /** Human-readable client device for the admin streams dashboard
   *  ("Chrome — macOS", "iPhone", "Chromecast — Living Room"). Cosmetic only. */
  @IsString()
  @IsOptional()
  deviceName?: string;

  /**
   * Force MPEG-TS segments for every transcode session of this device.
   * Hard override, used as an emergency switch (admin / debug). The
   * common case for Tizen is the narrower `useTsOnSingleAudio` flag
   * below; this one stays for clients that want TS regardless of audio
   * track count.
   */
  @IsBoolean()
  @IsOptional()
  useTs?: boolean;

  /**
   * Force MPEG-TS only when the source has zero or one audio track.
   *
   * Samsung Tizen AVPlay's HLS-fMP4 path requires demuxed audio and
   * video (per Samsung's General Specifications). For multi-audio
   * sources our `var_stream_map` layout already satisfies that, but
   * with a single audio rendition AVPlay never engages its rendition
   * probe and the variant stalls after the video init (issue #148).
   * MPEG-TS muxes A+V natively in the same segment, side-stepping the
   * probe entirely. The trade-off is no Dolby pass-through and a more
   * fragile HDR path, but it's the only documented Samsung-recommended
   * pattern for single-audio HLS on AVPlay.
   *
   * Browser, Cast and native mobile clients keep this `false` — they
   * happily play muxed fMP4.
   */
  @IsBoolean()
  @IsOptional()
  useTsOnSingleAudio?: boolean;
}
