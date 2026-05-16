import type {
  CodecVariant,
  EncoderDescriptor,
  EncoderRegistry,
  HdrFormat,
} from '../types';
import type { HwAccelType } from '../../types';
import { h264Qsv } from './h264-qsv';
import { h264Vaapi } from './h264-vaapi';
import { h264Nvenc } from './h264-nvenc';
import { h264Videotoolbox } from './h264-videotoolbox';
import { h264Cpu } from './h264-cpu';
import { hevcQsvHdr10, hevcQsvHlg } from './hevc-qsv';

/** Static registry of every encoder descriptor compiled in. The order
 *  matters: when multiple descriptors match a `(variant, hwAccel)` query
 *  the registry returns the first one in iteration order, so HW-accelerated
 *  entries come before CPU fallbacks. */
const DESCRIPTORS: readonly EncoderDescriptor[] = [
  h264Qsv,
  h264Vaapi,
  h264Nvenc,
  h264Videotoolbox,
  hevcQsvHdr10,
  hevcQsvHlg,
  // CPU fallback last — `candidates()` returns it as a last resort.
  h264Cpu,
];

class StaticRegistry implements EncoderRegistry {
  resolve(
    variant: CodecVariant,
    hwAccel: HwAccelType,
  ): EncoderDescriptor | null {
    // Pass 1: exact match on hwAccel.
    for (const d of DESCRIPTORS) {
      if (d.hwAccel !== hwAccel) continue;
      if (!variantMatches(d.variant, variant)) continue;
      if (!d.supports()) continue;
      if (variant.hdr && !d.supportsHdrMetadata()) continue;
      return d;
    }
    // Pass 2: CPU fallback for the same variant.
    if (hwAccel !== 'none') {
      for (const d of DESCRIPTORS) {
        if (d.hwAccel !== 'none') continue;
        if (!variantMatches(d.variant, variant)) continue;
        if (!d.supports()) continue;
        return d;
      }
    }
    return null;
  }

  candidates(variant: CodecVariant, hwAccel: HwAccelType): EncoderDescriptor[] {
    const out: EncoderDescriptor[] = [];
    // HW first, in declared order.
    for (const d of DESCRIPTORS) {
      if (d.hwAccel !== hwAccel) continue;
      if (!variantMatches(d.variant, variant)) continue;
      if (!d.supports()) continue;
      if (variant.hdr && !d.supportsHdrMetadata()) continue;
      out.push(d);
    }
    // Then CPU fallback (if it can produce this variant).
    if (hwAccel !== 'none') {
      for (const d of DESCRIPTORS) {
        if (d.hwAccel !== 'none') continue;
        if (!variantMatches(d.variant, variant)) continue;
        if (!d.supports()) continue;
        out.push(d);
      }
    }
    return out;
  }
}

/** Strict identity check on the variant tuple. `null` HDR matches only
 *  `null` HDR — SDR rungs never resolve to HDR descriptors and vice
 *  versa. */
function variantMatches(d: CodecVariant, q: CodecVariant): boolean {
  return (
    d.codec === q.codec && d.bitDepth === q.bitDepth && sameHdr(d.hdr, q.hdr)
  );
}

function sameHdr(a: HdrFormat | null, b: HdrFormat | null): boolean {
  return a === b;
}

export const encoderRegistry: EncoderRegistry = new StaticRegistry();
