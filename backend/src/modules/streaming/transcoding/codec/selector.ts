import type { CodecVariant, EncoderDescriptor, VideoCodec } from './types';
import type { DeviceProfileDto } from '../../dto/device-profile.dto';
import type { HwAccelType } from '../types';
import { encoderRegistry } from './encoders';
import { applyQuirks, type QuirkContext } from './fallback';

/**
 * Resolve an encoder for `variant` whose `hwAccel` matches the detected
 * backend. Returns null when the only match would be the CPU fallback,
 * so the selector can move on to the next codec in `codecOrder` instead
 * of locking in a CPU encode. `hwAccel === 'none'` accepts CPU encoders
 * unconditionally — that's the configuration of every deployment
 * without a usable HW backend.
 */
function resolveHwEncoder(
  variant: CodecVariant,
  hwAccel: HwAccelType,
): EncoderDescriptor | null {
  const enc = encoderRegistry.resolve(variant, hwAccel);
  if (!enc) return null;
  if (hwAccel === 'none') return enc;
  return enc.hwAccel === hwAccel ? enc : null;
}

/** Pick the codec variant(s) we'll expose to a given client. Order of
 *  preference (within each HDR/SDR group):
 *
 *  1. Source codec — when the client supports it, transcoding to the
 *     same codec preserves visual fidelity (no cross-codec artifacts)
 *     and reuses the most-tested HW path in this deployment.
 *  2. Efficiency ranking — AV1 > HEVC > H.264 for the remaining codecs.
 *
 *  Each candidate is gated on encoder availability via
 *  `encoderRegistry.resolve()`; combos with no working encoder are
 *  dropped. The quirks DB filters known-bad client/codec pairings last.
 *
 *  Returns the full ranked list; the caller usually emits only the top
 *  entry (one codec per master playlist — see the architecture plan
 *  §5.6) and keeps the rest for diagnostics / fallback. */
export function pickVariants(
  source: SourceInfoForSelector,
  profile: DeviceProfileDto,
  hwAccel: HwAccelType,
  userAgent: string,
): { variants: CodecVariant[]; quirksApplied: string[] } {
  const clientCodecs = new Set(
    profile.directPlayProfiles.flatMap((p) =>
      p.videoCodecs.map((c) => c.toLowerCase()),
    ),
  );

  const candidates: CodecVariant[] = [];

  // Codec ranking: source codec first when client supports it, then
  // efficiency fallback. H.264 last as the universal compatibility safety.
  const efficiencyOrder: VideoCodec[] = ['av1', 'hevc', 'h264'];
  const codecOrder: VideoCodec[] =
    source.codec && clientSupports(clientCodecs, source.codec)
      ? [source.codec, ...efficiencyOrder.filter((c) => c !== source.codec)]
      : efficiencyOrder;

  // HDR path — only meaningful when source is HDR AND client supports
  // an HDR display (browser caps + display gamut probe). H.264 is
  // skipped (8-bit only). Two passes: the HW pass picks the first
  // codec with a HW HDR encoder; the CPU pass runs only when no
  // candidate codec has a HW HDR encoder — that's the CPU
  // libx265/libsvtav1 HDR path on boxes without QSV/VAAPI/NVENC.
  if (source.hdr && profile.supportsHdr === true) {
    const beforeHdr = candidates.length;
    for (const codec of codecOrder) {
      if (codec === 'h264') continue;
      if (!clientSupports(clientCodecs, codec)) continue;
      if (!clientDecodesResolution(profile, codec, source.width, source.height))
        continue;
      const variant: CodecVariant = { codec, bitDepth: 10, hdr: source.hdr };
      if (resolveHwEncoder(variant, hwAccel)) {
        candidates.push(variant);
        break;
      }
    }
    if (candidates.length === beforeHdr) {
      for (const codec of codecOrder) {
        if (codec === 'h264') continue;
        if (!clientSupports(clientCodecs, codec)) continue;
        if (!clientDecodesResolution(profile, codec, source.width, source.height))
          continue;
        const variant: CodecVariant = { codec, bitDepth: 10, hdr: source.hdr };
        if (encoderRegistry.resolve(variant, hwAccel)) {
          candidates.push(variant);
          break;
        }
      }
    }
  }

  // SDR ladder — always present, even on HDR clients (they can tone-
  // map for the SDR fallback when the HDR encoder path is unavailable,
  // and they need an SDR base anyway for non-HDR sources). HW-first:
  // walk `codecOrder` accepting only encoders that match the detected
  // HW backend, so a HW runner-up beats a CPU-only source-codec match.
  // The CPU pass underneath only runs when no candidate codec has a
  // HW encoder at all — typical on hosts with no QSV/VAAPI/NVENC.
  const beforeSdr = candidates.length;
  for (const codec of codecOrder) {
    if (!clientSupports(clientCodecs, codec)) continue;
    if (!clientDecodesResolution(profile, codec, source.width, source.height))
      continue;
    const variant: CodecVariant = { codec, bitDepth: 8, hdr: null };
    if (resolveHwEncoder(variant, hwAccel)) {
      candidates.push(variant);
    }
  }
  if (candidates.length === beforeSdr) {
    for (const codec of codecOrder) {
      if (!clientSupports(clientCodecs, codec)) continue;
      if (!clientDecodesResolution(profile, codec, source.width, source.height))
        continue;
      const variant: CodecVariant = { codec, bitDepth: 8, hdr: null };
      if (encoderRegistry.resolve(variant, hwAccel)) {
        candidates.push(variant);
      }
    }
  }

  const ctx: QuirkContext = {
    profile,
    sourceWidth: source.width,
    sourceHeight: source.height,
    userAgent: userAgent.toLowerCase(),
  };
  const { variants, applied } = applyQuirks(candidates, ctx);
  return { variants, quirksApplied: applied };
}

/** Convenience: pick a single variant — the top-ranked one after quirks.
 *  Falls back to H.264 SDR if nothing else survives (universal codec
 *  every client claims to support). */
export function pickPrimaryVariant(
  source: SourceInfoForSelector,
  profile: DeviceProfileDto,
  hwAccel: HwAccelType,
  userAgent: string,
): CodecVariant {
  const { variants } = pickVariants(source, profile, hwAccel, userAgent);
  return variants[0] ?? { codec: 'h264', bitDepth: 8, hdr: null };
}

export interface SourceInfoForSelector {
  width: number;
  height: number;
  hdr: CodecVariant['hdr'];
  /** Source video codec (lowercased ffprobe name, normalised to the
   *  `VideoCodec` union). When set, the selector prefers transcoding to
   *  the same codec for fidelity and HW path predictability. */
  codec?: VideoCodec;
}

/** Codec name list comparison — clients send aliases (`hvc1`/`hev1` for
 *  HEVC, `avc1` for H.264) so we normalise both sides. */
function clientSupports(set: Set<string>, codec: VideoCodec): boolean {
  switch (codec) {
    case 'h264':
      return set.has('h264') || set.has('avc1');
    case 'hevc':
      return (
        set.has('hevc') || set.has('h265') || set.has('hvc1') || set.has('hev1')
      );
    case 'av1':
      return set.has('av1') || set.has('av01');
  }
}

/** Whether the client can DECODE `codec` at the resolution we intend to emit.
 *  A native client reports its HW decoder's per-codec max width/height; since
 *  one codec drives every rung of the master, a codec whose ceiling can't fit
 *  the top rung is unusable — a 4K source on a device that decodes AV1 only up
 *  to 2048 must fall back to HEVC. Compared in either orientation (the maxima
 *  can be reported rotated). Codecs with no declared ceiling always pass. */
function clientDecodesResolution(
  profile: DeviceProfileDto,
  codec: VideoCodec,
  width: number,
  height: number,
): boolean {
  const cond = profile.codecConditions?.find((c) => c.codec === codec);
  if (!cond) return true;
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const capLong = Math.max(cond.maxWidth ?? 0, cond.maxHeight ?? 0);
  const capShort = Math.min(cond.maxWidth ?? 0, cond.maxHeight ?? 0);
  if (capLong && long > capLong) return false;
  if (capShort && short > capShort) return false;
  return true;
}
