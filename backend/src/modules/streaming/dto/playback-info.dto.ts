/**
 * Playback info response — the backend's decision on how to play a media file.
 */

export type PlayMethod = 'DirectPlay' | 'DirectStream' | 'Transcode';

export interface TranscodeReason {
  flag: string;
  message: string;
}

/**
 * Per-audio-track playback decision, one entry per `streamInfo.audio` stream
 * in source order. The single top-level `audioPlan` / `transcodeReasons`
 * describe the default track only; multi-audio files are served as independent
 * EXT-X-MEDIA renditions, so the player switches audio client-side and needs
 * the copy/transcode reason of the *active* track, not the default. The client
 * looks this up by the active track's position (renditions are emitted in
 * `streamInfo.audio` order — see master-playlist generation).
 */
export interface AudioTrackPlan {
  /** Index into `streamInfo.audio` (source order). */
  index: number;
  language?: string;
  /** Source codec (lowercased ffprobe name). */
  codec: string;
  channels?: number;
  /** True when this track plays as-is (no re-encode). */
  copy: boolean;
  /** Codec the client actually hears for this track (uniform across the audio
   *  group on the HLS paths). */
  outputCodec: string;
  /** Output channel count (source channels when copied; downmixed to the
   *  device/codec cap when transcoded). */
  outputChannels?: number;
  /** Why this track is re-encoded (`Audio*` flags); empty when copied. */
  reasonFlags: string[];
}

/**
 * Server-authoritative quality option for the player UI.
 * Built from the per-device ladder and source bitrate — frontend renders
 * these verbatim (plus a prepended "Auto" entry).
 */
export interface QualityOption {
  /** 'original' | '2160p' | '1080p' | '720p' | '480p' | '360p' | '240p' | '144p' */
  id: string;
  /** Display label (e.g. "1080p", "4K"). */
  label: string;
  /** Target height in pixels (source height for `original`). */
  height: number;
  /** Target width in pixels (source width for `original`). Lets the client
   *  set native track-selection constraints without re-deriving widths from
   *  the rung id. */
  width?: number;
  /** Total bandwidth (video + audio) in bits/s for this rung. */
  totalBitrateBps: number;
  /** True when the 'original' rung maps to a DirectStream (remux) path. */
  isRemux: boolean;
  /** True on the reduced transcode rung shown alongside `original` at source resolution. */
  lowBandwidth?: boolean;
}

export interface PlaybackInfoResponse {
  mediaFileId: number;

  /** Chosen play method */
  playMethod: PlayMethod;

  /** URL to use for playback */
  playUrl: string;

  /** Content type of the play URL */
  contentType: string;

  /** Why transcoding/remuxing is needed (empty for DirectPlay) */
  transcodeReasons: TranscodeReason[];

  /** Whether video stream is being copied (not re-encoded) */
  videoCopyStream: boolean;

  /** Whether audio stream is being copied (not re-encoded) */
  audioCopyStream: boolean;

  /** Output video codec (same as source for copy, target for transcode) */
  outputVideoCodec: string;

  /** Output audio codec (same as source for copy, target for transcode) */
  outputAudioCodec: string;

  /** Canonical audio output decision. Authoritative; every downstream
   *  consumer (ffmpeg, admin dashboard, master playlist) reads from here. */
  audioPlan:
    | { mode: 'copy'; codec: string }
    | {
        mode: 'transcode';
        codec: 'aac' | 'ac3' | 'eac3';
        bitrateBps: number;
      };

  /** Output container format */
  outputContainer: string;

  /** Hardware acceleration type used for transcoding */
  hwAccel: string;

  /** Whether HDR→SDR tone mapping is being applied */
  tonemapping: boolean;

  /** Tone-map mechanism the session actually runs. `'vaapi'` / `'opencl'`
   *  / `'qsv'` for QSV/VAAPI encoders (after `auto` resolution + boot
   *  probe); `'videotoolbox'` for the macOS `scale_vt` Metal path; `'cpu'`
   *  for the CPU zscale chain (NVENC / libx26x / VideoToolbox with a
   *  burn-in or crop). `null` when no tone-mapping pass runs. Stats overlays
   *  show this value, not the (encoder-agnostic) admin pick. */
  tonemapAlgo?: 'vaapi' | 'opencl' | 'qsv' | 'videotoolbox' | 'cpu' | null;

  /** Tone-map curve (`hable` / `mobius` / `reinhard`), set only when
   *  `tonemapAlgo === 'cpu'`. Surfaced so the overlay names the exact
   *  curve in use. */
  tonemapCurve?: 'hable' | 'mobius' | 'reinhard';

  /**
   * Bitrate targets per quality rung (FFmpeg profiles).
   * Present when playMethod === 'Transcode', or **DirectStream** (a master with
   * a remux rung + the transcode ladder).
   * `totalBitrateBps` = video + audio = the **BANDWIDTH** value of the matching
   * line in `master.m3u8` (same computation as `generateMasterPlaylist`).
   */
  transcodeBitrateByQuality?: Record<
    string,
    {
      videoBitrateBps: number;
      audioBitrateBps: number;
      totalBitrateBps: number;
    }
  >;

  /**
   * BANDWIDTH of the "remux" variant in `master.m3u8` (video copy, no re-encode).
   * Present when playMethod === 'DirectStream' and the HLS URL includes remux.
   * Same computation as `StreamingController.hlsMaster` (ffprobe video + audio,
   * or the container format bitrate).
   */
  remuxMasterBandwidthBps?: number;

  /** Ordered list of quality rungs to show in the player UI (excluding "Auto"). */
  qualities?: QualityOption[];

  /** Per-audio-track copy/transcode decision, one entry per source audio
   *  stream. Lets the player show the reason for the *active* track after a
   *  client-side audio switch (the top-level `transcodeReasons` only describe
   *  the default track). */
  audioTracks?: AudioTrackPlan[];

  /** Source file info */
  source: {
    container: string;
    videoCodec: string;
    videoProfile?: string;
    videoLevel?: number;
    videoBitRate?: number;
    /** ffprobe container bitrate `format.bit_rate` (bits/s) — useful when the streams carry no bit_rate */
    formatBitRate?: number;
    videoBitDepth?: number;
    width?: number;
    height?: number;
    frameRate?: string;
    audioCodec: string;
    audioChannels?: number;
    audioChannelLayout?: string;
    audioBitRate?: number;
    audioSampleRate?: number;
    audioLanguage?: string;
    durationSeconds?: number;
    hdrFormat?: string;
    colorSpace?: string;
    colorTransfer?: string;
    colorPrimaries?: string;
    /** Detected letterbox crop region, when cropdetect found bars
     *  big enough to remove during transcode. Surfaced so the stats
     *  overlay can flag the active crop without re-running detect. */
    crop?: { width: number; height: number; x: number; y: number };
  };
}
