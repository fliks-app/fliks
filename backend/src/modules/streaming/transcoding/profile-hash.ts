import { createHash } from 'crypto';
import type { BitDepth, HdrFormat, VideoCodec } from './codec/types';

/**
 * Client platform classes that may produce byte-incompatible segments
 * even with otherwise identical codec / mux settings. The hash includes
 * this as a safety net against player-specific quirks (AVPlay box layout
 * on Tizen, WAM on webOS, AVPlayer HEVC tag handling on iOS, etc.) that
 * are not captured by codec + mux flavour alone.
 */
export type TvPlatform =
  | 'browser'
  | 'androidtv'
  | 'tizen'
  | 'webos'
  | 'ios'
  | 'android'
  | 'cast';

/**
 * The set of fields that uniquely determine the byte layout of the
 * transcoded segments produced for a given (user, mediaFile). Two
 * playbacks with the same {@link PlaybackProfile} can safely share the
 * same on-disk cache. Two playbacks that disagree on any field must
 * write to separate cache directories — segments would otherwise drift
 * from the master playlist's CODECS string or fail to parse on the
 * target player.
 */
export interface PlaybackProfile {
  videoCodec: VideoCodec;
  videoBitDepth: BitDepth;
  hdr: HdrFormat | null;
  audioCodec: string;
  audioChannels: number;
  audioMode: 'copy' | 'transcode';
  muxFlavour: 'ts' | 'fmp4';
  audioLayout: 'inline' | 'var-stream-map';
  segmentDurationMs: number;
  tvPlatform: TvPlatform;
}

/**
 * Stable, order-independent serialisation of a {@link PlaybackProfile}.
 * Keys are emitted in a fixed order; `null` is serialised as the literal
 * string `"null"`. Used as the sha1 input — never persisted as-is, so
 * the format is free to evolve as long as new fields are appended.
 */
function canonicalise(profile: PlaybackProfile): string {
  return [
    `v=${profile.videoCodec}`,
    `vd=${profile.videoBitDepth}`,
    `h=${profile.hdr ?? 'null'}`,
    `a=${profile.audioCodec}`,
    `ac=${profile.audioChannels}`,
    `am=${profile.audioMode}`,
    `mux=${profile.muxFlavour}`,
    `al=${profile.audioLayout}`,
    `sd=${profile.segmentDurationMs}`,
    `tv=${profile.tvPlatform}`,
  ].join('|');
}

/**
 * Compute the directory-naming hash for a profile. 10 hex chars = 40 bits,
 * negligible collision probability for the realistic number of profile
 * combinations (~ hundreds in production).
 */
export function computeProfileHash(profile: PlaybackProfile): string {
  return createHash('sha1')
    .update(canonicalise(profile))
    .digest('hex')
    .slice(0, 10);
}
