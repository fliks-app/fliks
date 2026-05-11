/**
 * Playback info response — the backend's decision on how to play a media file.
 */

export type PlayMethod = 'DirectPlay' | 'DirectStream' | 'Transcode';

export interface TranscodeReason {
  flag: string;
  message: string;
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

  /**
   * Cibles de débit par rung de qualité (profils FFmpeg).
   * Présent si playMethod === 'Transcode', ou **DirectStream** (master avec remux + échelle transcodage).
   * `totalBitrateBps` = somme vidéo + audio = valeur **BANDWIDTH** de la ligne correspondante
   * dans `master.m3u8` (même calcul que `generateMasterPlaylist`).
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
   * BANDWIDTH de la variante « remux » dans `master.m3u8` (copie vidéo sans réencodage).
   * Présent si playMethod === 'DirectStream' et URL HLS avec remux.
   * Même calcul que `StreamingController.hlsMaster` (ffprobe vidéo + audio ou format).
   */
  remuxMasterBandwidthBps?: number;

  /** Ordered list of quality rungs to show in the player UI (excluding "Auto"). */
  qualities?: QualityOption[];

  /** Source file info */
  source: {
    container: string;
    videoCodec: string;
    videoProfile?: string;
    videoLevel?: number;
    videoBitRate?: number;
    /** Débit conteneur ffprobe `format.bit_rate` (bits/s) — utile quand les flux n’ont pas de bit_rate */
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
  };
}
