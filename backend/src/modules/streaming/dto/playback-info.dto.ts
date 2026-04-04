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

  /** Source file info */
  source: {
    container: string;
    videoCodec: string;
    videoProfile?: string;
    videoLevel?: number;
    videoBitRate?: number;
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
  };
}
