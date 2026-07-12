import { bucketResolutionHeight } from '../../../../common/utils/resolution.util';
import type { CodecVariant } from './types';
import type { DeviceProfileDto } from '../../dto/device-profile.dto';

/** A client-specific override that filters or rewrites the candidate
 *  variant list. Used to drop codec/HDR/resolution combinations a client
 *  claims to support but that fail in practice — typically Chromecast
 *  receivers whose `canDisplayType` returns true for codecs the device
 *  silently rejects at decode time. */
export interface ClientQuirk {
  /** Stable id for logging — visible in playback-info diagnostics. */
  readonly id: string;
  /** Predicate. Receives the device profile sent by the client (UA-derived
   *  hints, codec list, channel count, etc.) and any extra HTTP context
   *  passed to the resolver. Return `true` iff this quirk applies. */
  matches(ctx: QuirkContext): boolean;
  /** Filter / rewrite the variant list. Implementations should be
   *  idempotent — apply twice = same result as apply once. */
  filter(variants: CodecVariant[], ctx: QuirkContext): CodecVariant[];
  /** Free-text reason — surfaced in playback-info `transcodeReasons` so
   *  the admin dashboard can show *why* a client wasn't offered HEVC. */
  readonly reason: string;
}

export interface QuirkContext {
  profile: DeviceProfileDto;
  /** Source frame dimensions. Both axes are required so resolution-
   *  gated quirks ("X codec but only ≤ 1080p", e.g. CCwGTV HD silently
   *  failing HEVC Main10 @ 4K) can bucket via
   *  {@link bucketResolutionHeight} — height alone mis-classifies
   *  anamorphic / scope crops like 1918×872. */
  sourceWidth: number;
  sourceHeight: number;
  /** Lowercased `User-Agent` header. Optional — quirks that key on
   *  HTTP-only signals (e.g. specific Chromecast firmware versions)
   *  read this. */
  userAgent: string;
}

const CCWGTV_HD_NO_4K_HEVC_HDR: ClientQuirk = {
  id: 'ccwgtv-hd-no-4k-hevc-hdr',
  matches: (ctx) =>
    /chromecast.+google.+tv/i.test(ctx.userAgent) &&
    !/4k/i.test(ctx.userAgent) &&
    bucketResolutionHeight(ctx.sourceWidth, ctx.sourceHeight) > 1080,
  filter: (variants) =>
    variants.filter((v) => !(v.codec === 'hevc' && v.hdr !== null)),
  reason:
    'Chromecast with Google TV (HD) silently fails HEVC Main10 above 1080p',
};

const OLDER_CHROMECAST_NO_AV1: ClientQuirk = {
  id: 'older-chromecast-no-av1',
  matches: (ctx) => {
    if (!/cast|chromecast/i.test(ctx.userAgent)) return false;
    // Google TV Streamer (2024) is the first Cast receiver with HW AV1
    // decode reliably available; everything older silently fails on AV1.
    return !/streamer|google.+tv\b/i.test(ctx.userAgent);
  },
  filter: (variants) => variants.filter((v) => v.codec !== 'av1'),
  reason: 'Pre-2024 Chromecast receivers lack reliable HW AV1 decode',
};

const APPLE_TV_PRE_A17_NO_AV1: ClientQuirk = {
  id: 'apple-pre-a17-no-av1',
  matches: (ctx) => {
    // AV1 HW decode is iPhone 15 Pro / iPad M3 / Apple TV with A17+
    // (none shipped yet on Apple TV at time of writing). Be conservative:
    // any iOS UA without a clear A17+ signal drops AV1.
    if (!/iphone|ipad|apple.?tv/i.test(ctx.userAgent)) return false;
    return !/cpu (iphone )?os 17_4|version\/17\.4/i.test(ctx.userAgent);
  },
  filter: (variants) => variants.filter((v) => v.codec !== 'av1'),
  reason: 'iOS / Apple TV without A17 HW AV1 decoder',
};

const REGISTRY: readonly ClientQuirk[] = [
  CCWGTV_HD_NO_4K_HEVC_HDR,
  OLDER_CHROMECAST_NO_AV1,
  APPLE_TV_PRE_A17_NO_AV1,
];

/** Run every applicable quirk against the candidate variants. Returns
 *  the filtered list plus the ids of the quirks that fired (for log /
 *  diagnostic surfacing). */
export function applyQuirks(
  variants: CodecVariant[],
  ctx: QuirkContext,
): { variants: CodecVariant[]; applied: string[] } {
  let current = variants;
  const applied: string[] = [];
  for (const quirk of REGISTRY) {
    if (!quirk.matches(ctx)) continue;
    const next = quirk.filter(current, ctx);
    if (next.length !== current.length) applied.push(quirk.id);
    current = next;
  }
  return { variants: current, applied };
}
