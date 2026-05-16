import type { CodecVariant, VideoCodec } from './types';
import type { DeviceProfileDto } from '../../dto/device-profile.dto';
import type { HwAccelType } from '../types';
import { encoderRegistry } from './encoders';
import { applyQuirks, type QuirkContext } from './fallback';

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
      ? [
          source.codec,
          ...efficiencyOrder.filter((c) => c !== source.codec),
        ]
      : efficiencyOrder;

  // HDR path — only meaningful when source is HDR AND client supports
  // an HDR display (browser caps + display gamut probe). H.264 is
  // skipped (8-bit only). First codec with a resolvable HDR encoder
  // (HW + HDR metadata, or CPU libx265/libsvtav1 fallback) wins.
  if (source.hdr && profile.supportsHdr === true) {
    for (const codec of codecOrder) {
      if (codec === 'h264') continue;
      if (!clientSupports(clientCodecs, codec)) continue;
      const variant: CodecVariant = { codec, bitDepth: 10, hdr: source.hdr };
      if (encoderRegistry.resolve(variant, hwAccel)) {
        candidates.push(variant);
        break;
      }
    }
  }

  // SDR ladder — always present, even on HDR clients (they can tone-map
  // for the SDR fallback when the HDR encoder path is unavailable, and
  // they need an SDR base anyway for legacy non-HDR sources).
  for (const codec of codecOrder) {
    if (!clientSupports(clientCodecs, codec)) continue;
    const variant: CodecVariant = { codec, bitDepth: 8, hdr: null };
    if (encoderRegistry.resolve(variant, hwAccel)) {
      candidates.push(variant);
    }
  }

  const ctx: QuirkContext = {
    profile,
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
