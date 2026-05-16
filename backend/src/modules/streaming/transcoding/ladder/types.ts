import type { CodecVariant } from '../codec/types';

/** A single rung of the master playlist. `id` is the URL fragment served
 *  on the wire (e.g. `2160p-hevc-hdr10`); the player passes it back as
 *  `:quality` on segment requests. */
export interface LadderRung {
  id: string;
  variant: CodecVariant;
  width: number;
  height: number;
  videoBitrateBps: number;
  audioBitrateBps: number;
  /** UI label exposed by the quality picker (e.g. "4K HDR"). */
  label: string;
}

/** Multi-audio renditions referenced by every video rung via
 *  `AUDIO="audio"`. Empty when the source is single-audio (audio is
 *  muxed into the video segments instead). */
export interface AudioRendition {
  /** Index of the audio track in the source file. */
  sourceIndex: number;
  language: string;
  name: string;
  isDefault: boolean;
}

/** Output of the ladder builder. Consumed by the master playlist
 *  emitter and the HLS controller (to validate quality strings on
 *  segment requests). */
export interface LadderSpec {
  rungs: LadderRung[];
  audioRenditions: AudioRendition[];
  /** True when audio is served via separate `EXT-X-MEDIA` renditions
   *  (var_stream_map on the video session, or a dedicated audio
   *  ffmpeg session). False = audio is muxed inside the video segments. */
  splitAudio: boolean;
}
