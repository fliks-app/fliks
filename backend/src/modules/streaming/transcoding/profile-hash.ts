import { createHash } from 'crypto';
import type { BitDepth, HdrFormat, VideoCodec } from './codec/types';
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
  const audioCodec = ctx?.audioPlan?.codec ?? 'aac';
  const audioChannels = pickAudioChannels(ctx);
  const audioMode = ctx?.audioPlan?.mode ?? 'transcode';
  const videoVariant = ctx?.videoVariant;
  return {
    videoCodec: videoVariant?.codec ?? 'h264',
    videoBitDepth: videoVariant?.bitDepth ?? 8,
    hdr: videoVariant?.hdr ?? null,
    audioCodec,
    audioChannels,
    audioMode,
    muxFlavour: ctx?.useTs ? 'ts' : 'fmp4',
    audioLayout: pickAudioLayout(ctx),
    segmentDurationMs,
    tvPlatform: 'browser',
  };
}

function pickAudioChannels(ctx: SessionContext | undefined): number {
  // SessionContext doesn't carry channel count today; default to 2 for
  // transcode (always downmixed to stereo for AAC) and 6 for surround
  // copy paths (EAC-3/AC-3/DTS/TrueHD copy preserves the source layout,
  // which is 5.1 in the overwhelming majority of releases that pick the
  // surround copy branch). A more precise channel count will be plumbed
  // through once SessionContext exposes it.
  if (ctx?.audioPlan?.mode === 'copy') {
    const codec = ctx.audioPlan.codec.toLowerCase();
    if (
      codec === 'eac3' ||
      codec === 'ac3' ||
      codec === 'dts' ||
      codec === 'truehd'
    ) {
      return 6;
    }
  }
  return 2;
}

function pickAudioLayout(
  ctx: SessionContext | undefined,
): 'inline' | 'var-stream-map' {
  const isVideoOnly = ctx?.videoOnly ?? false;
  const streams = ctx?.audioStreams;
  return isVideoOnly && streams && streams.length > 1
    ? 'var-stream-map'
    : 'inline';
}
