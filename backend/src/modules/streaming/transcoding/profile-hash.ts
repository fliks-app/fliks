import { createHash } from 'crypto';
import type { BitDepth, HdrFormat, VideoCodec } from './codec/types';
import { varStreamMapLayout } from './audio-layout';
import { audioEncoderName, DEFAULT_AUDIO_PLAN } from './audio-encode';
import type { SessionContext } from './types';

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
  /** Encoder binary a transcode runs on (e.g. `aac` vs `libfdk_aac`): same
   *  codec, different segment bytes. `'copy'` when the plan doesn't encode. */
  audioEncoderId: string;
  /** Per-rendition copy (`c`) / transcode (`t<channels><encoderId>`) mask of a
   *  var_stream_map group. */
  audioTrackModes?: string;
  muxFlavour: 'ts' | 'fmp4';
  audioLayout: 'inline' | 'var-stream-map';
  segmentDurationMs: number;
  tvPlatform: TvPlatform;
  /** Source timeline every run is cut against (`sourceTimeline`): a rescan
   *  that moves it must not reuse segments timed against the old one. */
  origin: number;
  formatStart: number;
  /** {@link SessionContext.sourceVersion}. */
  sourceVersion: string | null;
  /** {@link SessionContext.dolbyVision}: a DV session writes a `dvvC` box the
   *  init segment otherwise lacks, so it can never share a non-DV cache dir. */
  dolbyVision: boolean;
}

/** Segment timeline layout (edit lists, tfdt origin, audio alignment). Raised
 *  whenever it changes so cached segments of the old layout never mix in. */
export const SEGMENT_TIMELINE_VERSION = 1;

/**
 * Stable, order-independent serialisation of a {@link PlaybackProfile}.
 * Keys are emitted in a fixed order; `null` is serialised as the literal
 * string `"null"`. Used as the sha1 input — never persisted as-is, so
 * the format is free to evolve as long as new fields are appended.
 */
function canonicalise(profile: PlaybackProfile): string {
  // A group's `atm` already hashes every rendition; the picked track's own
  // channels/mode would fork the cache by pick, not by actual output.
  const grouped = profile.audioLayout === 'var-stream-map';
  return [
    `v=${profile.videoCodec}`,
    `vd=${profile.videoBitDepth}`,
    `h=${profile.hdr ?? 'null'}`,
    `a=${profile.audioCodec}`,
    ...(grouped
      ? [`atm=${profile.audioTrackModes ?? ''}`]
      : [
          `ac=${profile.audioChannels}`,
          `am=${profile.audioMode}`,
          `ae=${profile.audioEncoderId}`,
        ]),
    `mux=${profile.muxFlavour}`,
    `al=${profile.audioLayout}`,
    `sd=${profile.segmentDurationMs}`,
    `tv=${profile.tvPlatform}`,
    `tl=${SEGMENT_TIMELINE_VERSION}`,
    `o=${profile.origin}`,
    `fs=${profile.formatStart}`,
    `sv=${profile.sourceVersion ?? ''}`,
    ...(profile.dolbyVision ? [`dv=1`] : []),
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

/**
 * Best-effort derivation of a {@link PlaybackProfile} from the existing
 * {@link SessionContext}. Used by the transcoding service to compute
 * the on-disk cache directory for a session. Fields not yet propagated
 * from the front-end (notably `tvPlatform`) fall back to safe defaults
 * — the resulting hash is stable for a given (ctx, quality) pair within
 * a single backend run, which is all the cache layout requires.
 */
export function buildPlaybackProfileFromContext(
  ctx: SessionContext | undefined,
  segmentDurationMs: number,
): PlaybackProfile {
  const videoVariant = ctx?.videoVariant;
  const audioPlan = ctx?.audioPlan ?? DEFAULT_AUDIO_PLAN;
  return {
    videoCodec: videoVariant?.codec ?? 'h264',
    videoBitDepth: videoVariant?.bitDepth ?? 8,
    hdr: videoVariant?.hdr ?? null,
    audioCodec: audioPlan.codec,
    audioChannels: audioPlan.channels ?? 2,
    audioMode: audioPlan.mode,
    audioEncoderId:
      audioPlan.mode === 'copy'
        ? 'copy'
        : audioEncoderName(audioPlan.codec, audioPlan.channels),
    audioTrackModes: ctx?.audioTrackPlans
      ?.map((p) =>
        p.mode === 'copy'
          ? 'c'
          : `t${p.channels}${audioEncoderName(p.codec, p.channels)}`,
      )
      .join(''),
    muxFlavour: ctx?.useTs ? 'ts' : 'fmp4',
    audioLayout: varStreamMapLayout(
      ctx?.videoOnly ?? false,
      ctx?.audioStreams?.length ?? 0,
    )
      ? 'var-stream-map'
      : 'inline',
    segmentDurationMs,
    tvPlatform: 'browser',
    origin: ctx?.sourceStartPts ?? 0,
    formatStart: ctx?.sourceFormatStart ?? ctx?.sourceStartPts ?? 0,
    sourceVersion: ctx?.sourceVersion ?? null,
    dolbyVision: ctx?.dolbyVision ?? false,
  };
}
