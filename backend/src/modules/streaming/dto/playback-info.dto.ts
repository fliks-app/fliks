/**
 * Playback info response — the backend's decision on how to play a media file.
 */

export type PlayMethod = 'DirectPlay' | 'DirectStream' | 'Transcode';

export interface TranscodeReason {
  flag: string;
  message: string;
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

  /** Output container format */
  outputContainer: string;

  /** Hardware acceleration type used for transcoding */
  hwAccel: string;

  /** Whether HDR→SDR tone mapping is being applied */
  tonemapping: boolean;

  /**
   * Cibles de débit par rung de qualité (profils FFmpeg), aligné Jellyfin TranscodingInfo.
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
