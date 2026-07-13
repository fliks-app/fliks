import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
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

  /**
   * Per-audio-codec max decodable channel count (e.g. `{aac: 8, eac3: 6}`),
   * keyed by lowercased codec. The device can decode a codec up to this many
   * channels (the OS downmixes to the real output). Lets the backend allow a
   * 7.1 AAC source while still downmixing a 7.1 EAC-3 source whose decoder
   * tops out at 5.1 on the same device. Falls back to {@link maxAudioChannels}
   * for codecs absent from the map.
   */
  @IsObject()
  @IsOptional()
  audioChannelsByCodec?: Record<string, number>;

  @IsBoolean()
  @IsOptional()
  supportsHdr?: boolean;

  /**
   * Client can present single-layer Dolby Vision (Profile 5 / 8.x) directly:
   * both a DV decoder and a DV panel confirmed on the device. The backend then
   * DirectPlays the original container untouched so the RPU rides through.
   * ABSENT means false — the opposite of {@link supportsDirectPlay} — so a
   * client that hasn't proven DV never gets a P5 copied (it would render
   * green/purple on non-DV hardware); such clients keep the tonemap transcode.
   */
  @IsBoolean()
  @IsOptional()
  supportsDolbyVision?: boolean;

  /**
   * Client engine can play a raw progressive file served as-is (Direct Play).
   * Shaka (web), ExoPlayer/AVPlayer (native mobile) and webOS `<video>` all
   * can. Samsung Tizen AVPlay is HLS-only and cannot open a raw file, so it
   * sends `false`: the backend then never returns `DirectPlay` for it and
   * falls back to DirectStream (remux to HLS, codec-copy — still no
   * re-encode). Unset is treated as `true` for backward compatibility.
   */
  @IsBoolean()
  @IsOptional()
  supportsDirectPlay?: boolean;

  /**
   * Client renders HLS `SUBTITLES` renditions natively (AVPlayer, ExoPlayer,
   * Tizen AVPlay, webOS), so the master advertises a subtitle group and cues
   * show in PiP / AirPlay / lock-screen. Web (Shaka) leaves this unset and
   * keeps fetching sidecar VTT, which renders better multi-line cues via its
   * own text displayer.
   */
  @IsBoolean()
  @IsOptional()
  supportsHlsSubtitles?: boolean;

  /**
   * Engine renders bitmap (PGS/VOBSUB) subtitles itself (ExoPlayer, mpv), so
   * they're shown natively rather than burned in. Client-side hint; the backend
   * accepts it for forward-compat (burn-in is client-initiated via
   * `burnInSubtitleId`), so it's whitelisted here even though unused.
   */
  @IsBoolean()
  @IsOptional()
  supportsImageSubtitles?: boolean;

  /**
   * Engine fetches the first VOD segment (seg-0) when it loads the playlist
   * and then seeks to the resume point — Shaka (web) and the Cast receiver do
   * this. The backend pre-spawns a short seg-0 "early-start" companion next to
   * the main session so that probe lands instantly. Native engines (AVPlayer,
   * ExoPlayer, AVPlay, webOS) seek straight to the target segment and never
   * request seg-0, so they leave this false and the backend skips the
   * companion — for them it is a wasted parallel transcode.
   */
  @IsBoolean()
  @IsOptional()
  probesSegZero?: boolean;

  @IsIn(['mobile', 'desktop'])
  @IsOptional()
  deviceType?: 'mobile' | 'desktop';

  /** Human-readable client device for the admin streams dashboard
   *  ("Chrome — macOS", "iPhone", "Chromecast — Living Room"). Cosmetic only. */
  @IsString()
  @IsOptional()
  deviceName?: string;

  /** Real host OS name+version ("macOS 26", "iOS 18.5") resolved natively by the
   *  client; the admin label prefers this over the frozen-UA OS. Cosmetic only. */
  @IsString()
  @IsOptional()
  @MaxLength(60)
  systemName?: string;

  /** Fliks client build version ("1.15.2"), sent only by non-web clients
   *  (native app / TV / desktop). Web omits it — its bundle is always the
   *  server's current build, so a version there is redundant. Shown next to
   *  the device label on the admin streams dashboard. Cosmetic only. */
  @IsString()
  @IsOptional()
  @MaxLength(40)
  appVersion?: string;

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
