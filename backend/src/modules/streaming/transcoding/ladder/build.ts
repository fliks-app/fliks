import type { CodecVariant } from '../codec/types';
import type { DeviceType } from '../types';
import { availableHeights, bitrateForRung } from './bitrates';
import type { LadderRung, LadderSpec, AudioRendition } from './types';

/** Build the ladder for one variant. Each rung is the same codec/HDR
 *  combo at a different resolution; the player picks the rung that fits
 *  its display + bandwidth. Heights cap at the source resolution to
 *  avoid pointless upscaling. */
export function buildLadderForVariant(
  variant: CodecVariant,
  source: { width: number; height: number },
  deviceType: DeviceType,
  audioRenditions: AudioRendition[],
): LadderSpec {
  const heights = availableHeights(deviceType, source.height);

  const rungs: LadderRung[] = heights.map((height) => {
    const {
      videoBps,
      audioBps,
      width: rungWidth,
    } = bitrateForRung(deviceType, variant, height);
    const w = Math.min(rungWidth, source.width);
    const h = Math.floor((w * source.height) / source.width / 16) * 16 || 16;
    return {
      id: rungIdFor(variant, height),
      variant,
      width: w,
      height: h,
      videoBitrateBps: videoBps,
      audioBitrateBps: audioBps,
      label: labelFor(variant, height),
    };
  });

  return {
    rungs,
    audioRenditions,
    splitAudio: audioRenditions.length > 0,
  };
}

/** Stable URL fragment used by HLS segment routes — `:quality` is parsed
 *  back to a variant via `parseRungId`. Format keeps the existing
 *  scheme (`1080p`, `2160p-hdr`) compatible: H.264 SDR rungs stay
 *  bare (`1080p`), other codecs get a suffix.
 *
 *  Examples:
 *  - H.264 SDR 1080p → `1080p`
 *  - H.264 SDR 2160p → `2160p`
 *  - HEVC SDR 1080p → `1080p-hevc`
 *  - HEVC HDR10 2160p → `2160p-hevc-hdr10`
 *  - HEVC HLG 1080p → `1080p-hevc-hlg`
 *  - AV1 HDR10 2160p → `2160p-av1-hdr10` */
export function rungIdFor(variant: CodecVariant, height: number): string {
  const tag = codecTag(variant);
  const hdr = variant.hdr ? `-${variant.hdr.toLowerCase()}` : '';
  return tag ? `${height}p-${tag}${hdr}` : `${height}p${hdr}`;
}

function codecTag(variant: CodecVariant): string {
  switch (variant.codec) {
    case 'h264':
      // H.264 SDR rungs keep the legacy bare name (`1080p`). HDR-tagged
      // H.264 doesn't exist (codec is 8-bit only) — defensive fallthrough.
      return variant.hdr ? 'h264' : '';
    case 'hevc':
      return 'hevc';
    case 'av1':
      return 'av1';
  }
}

function labelFor(variant: CodecVariant, height: number): string {
  const res = height === 2160 ? '4K' : `${height}p`;
  if (variant.hdr === 'HDR10') return `${res} HDR`;
  if (variant.hdr === 'HLG') return `${res} HLG`;
  if (variant.hdr) return `${res} ${variant.hdr}`;
  return res;
}

/** Parse a rung id back to its variant + height — used by the segment
 *  handler when the player asks for `/api/stream/N/2160p-hevc-hdr10/...`. */
export function parseRungId(id: string): {
  variant: CodecVariant;
  height: number;
} | null {
  const m = id.match(/^(\d+)p(?:-([a-z0-9]+))?(?:-([a-z0-9]+))?$/i);
  if (!m) return null;
  const height = parseInt(m[1], 10);
  const tagA = m[2]?.toLowerCase();
  const tagB = m[3]?.toLowerCase();
  // Order is [height]p-[codec?]-[hdr?]. When only one tag is present it
  // could be either codec or HDR — disambiguate by checking the known
  // codec tags first.
  const knownCodecs = new Set(['hevc', 'av1', 'h264']);
  const knownHdr = new Map<string, CodecVariant['hdr']>([
    ['hdr10', 'HDR10'],
    ['hlg', 'HLG'],
    ['dv5', 'DV5'],
    ['dv81', 'DV81'],
    ['dv84', 'DV84'],
  ]);

  let codec: CodecVariant['codec'] = 'h264';
  let hdr: CodecVariant['hdr'] = null;
  if (tagA && knownCodecs.has(tagA)) {
    codec = tagA as CodecVariant['codec'];
    if (tagB && knownHdr.has(tagB)) hdr = knownHdr.get(tagB) ?? null;
  } else if (tagA && knownHdr.has(tagA)) {
    hdr = knownHdr.get(tagA) ?? null;
  } else if (tagA) {
    return null;
  }

  const bitDepth = hdr ? 10 : 8;
  return { variant: { codec, bitDepth, hdr }, height };
}
