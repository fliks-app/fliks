import type {
  CodecVariant,
  EncoderDescriptor,
  EncoderRegistry,
  HdrFormat,
} from '../types';
import type { HwAccelType } from '../../types';
import { isEncoderEnabled } from '../encoder-probe';
import { h264Qsv } from './h264-qsv';
import { h264Vaapi } from './h264-vaapi';
import { h264Nvenc } from './h264-nvenc';
import { h264Videotoolbox } from './h264-videotoolbox';
import { h264Cpu } from './h264-cpu';
import { hevcQsv, hevcQsvHdr10, hevcQsvHlg } from './hevc-qsv';
import { hevcVaapi, hevcVaapiHdr10, hevcVaapiHlg } from './hevc-vaapi';
import { hevcNvenc, hevcNvencHdr10, hevcNvencHlg } from './hevc-nvenc';
import {
  hevcVideotoolbox,
  hevcVideotoolboxHdr10,
  hevcVideotoolboxHlg,
} from './hevc-videotoolbox';
import { hevcCpu, hevcCpuHdr10, hevcCpuHlg } from './hevc-cpu';
import { av1Qsv, av1QsvHdr10 } from './av1-qsv';
import { av1Vaapi, av1VaapiHdr10 } from './av1-vaapi';
import { av1Nvenc, av1NvencHdr10, av1NvencHlg } from './av1-nvenc';
import { av1Cpu, av1CpuHdr10, av1CpuHlg } from './av1-cpu';

/** Static registry of every encoder descriptor compiled in. The order
 *  matters: when multiple descriptors match a `(variant, hwAccel)` query
 *  the registry returns the first one in iteration order, so HW-accelerated
 *  entries come before CPU fallbacks. */
const DESCRIPTORS: readonly EncoderDescriptor[] = [
  // HEVC HW
  hevcQsv,
  hevcQsvHdr10,
  hevcQsvHlg,
  hevcVaapi,
  hevcVaapiHdr10,
  hevcVaapiHlg,
  hevcNvenc,
  hevcNvencHdr10,
  hevcNvencHlg,
  hevcVideotoolbox,
  hevcVideotoolboxHdr10,
  hevcVideotoolboxHlg,
  // AV1 HW
  av1Qsv,
  av1QsvHdr10,
  av1Vaapi,
  av1VaapiHdr10,
  av1Nvenc,
  av1NvencHdr10,
  av1NvencHlg,
  // H.264 HW
  h264Qsv,
  h264Vaapi,
  h264Nvenc,
  h264Videotoolbox,
  // CPU fallback last — `candidates()` returns it as a last resort.
  hevcCpu,
  hevcCpuHdr10,
  hevcCpuHlg,
  av1Cpu,
  av1CpuHdr10,
  av1CpuHlg,
  h264Cpu,
];

/** Gate combining the build-time `supports()` check and the runtime
 *  one-frame probe result. An encoder is only usable when both pass. */
function isUsable(d: EncoderDescriptor, variant: CodecVariant): boolean {
  if (!d.supports()) return false;
  if (variant.hdr && !d.supportsHdrMetadata()) return false;
  if (!isEncoderEnabled(d.id)) return false;
  return true;
}

class StaticRegistry implements EncoderRegistry {
  resolve(
    variant: CodecVariant,
    hwAccel: HwAccelType,
  ): EncoderDescriptor | null {
    // Pass 1: exact match on hwAccel.
    for (const d of DESCRIPTORS) {
      if (d.hwAccel !== hwAccel) continue;
      if (!variantMatches(d.variant, variant)) continue;
      if (!isUsable(d, variant)) continue;
      return d;
    }
    // Pass 2: CPU fallback for the same variant.
    if (hwAccel !== 'none') {
      for (const d of DESCRIPTORS) {
        if (d.hwAccel !== 'none') continue;
        if (!variantMatches(d.variant, variant)) continue;
        if (!isUsable(d, variant)) continue;
        return d;
      }
    }
    return null;
  }

}

/** Full list of compiled-in encoder descriptors. Exposed so the
 *  startup probe layer can iterate every encoder and run its
 *  one-frame test. */
export const ALL_DESCRIPTORS = DESCRIPTORS;

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
