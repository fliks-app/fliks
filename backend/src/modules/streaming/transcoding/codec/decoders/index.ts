import type { HwAccelType } from '../../types';
import type { VideoCodec } from '../types';
import { isDecoderEnabled } from '../decoder-probe';
import { cpuDecoder } from './cpu';
import {
  h264QsvDecoder,
  hevcQsvDecoder,
  av1QsvDecoder,
  h264QsvNativeDecoder,
  hevcQsvNativeDecoder,
  av1QsvNativeDecoder,
} from './qsv';
import { h264VaapiDecoder, hevcVaapiDecoder, av1VaapiDecoder } from './vaapi';
import { h264CudaDecoder, hevcCudaDecoder, av1CudaDecoder } from './nvenc';
import {
  h264VideotoolboxDecoder,
  hevcVideotoolboxDecoder,
} from './videotoolbox';
import type {
  DecoderDescriptor,
  DecoderRegistry,
  DecoderSourceInfo,
} from './types';

/** Static registry of every decoder descriptor compiled in. Order
 *  matters: the first match wins when iterating, so HW entries come
 *  before CPU. Within HW, we keep platform-native first (QSV before
 *  VAAPI on Intel Linux to bias `vpp_qsv` crop). */
const DESCRIPTORS: readonly DecoderDescriptor[] = [
  // Intel modern path. Default qsv decoder emits VAAPI surfaces (drop-
  // in compatible with the scale_vaapi-based encoder chains). A
  // qsv-native variant emits QSV surfaces directly — selected only by
  // paths that opt in (vpp_qsv crop in Phase 5+).
  h264QsvDecoder,
  hevcQsvDecoder,
  av1QsvDecoder,
  // Universal Linux fallback (also serves AMD).
  h264VaapiDecoder,
  hevcVaapiDecoder,
  av1VaapiDecoder,
  // NVIDIA.
  h264CudaDecoder,
  hevcCudaDecoder,
  av1CudaDecoder,
  // Apple.
  h264VideotoolboxDecoder,
  hevcVideotoolboxDecoder,
  // CPU last — always wins as fallback for any codec.
  cpuDecoder,
];

function matchesCodec(d: DecoderDescriptor, codec: VideoCodec): boolean {
  return d.sourceCodec === 'any' || d.sourceCodec === codec;
}

function isUsable(d: DecoderDescriptor, src: DecoderSourceInfo): boolean {
  if (!d.supports()) return false;
  if (!matchesCodec(d, src.codec)) return false;
  if (src.bitDepth > d.maxBitDepth) return false;
  if (!isDecoderEnabled(d.id)) return false;
  return true;
}

class StaticDecoderRegistry implements DecoderRegistry {
  resolve(
    source: DecoderSourceInfo,
    preferredHwAccel: HwAccelType,
  ): DecoderDescriptor {
    // Pass 1: exact family match (decoder + encoder share surface
    // device → bridge filter empty).
    for (const d of DESCRIPTORS) {
      if (d.hwAccel !== preferredHwAccel) continue;
      if (!isUsable(d, source)) continue;
      return d;
    }
    // Pass 2: any other HW decoder that can handle the codec — the
    // surface bridge picks up the inter-device hop.
    if (preferredHwAccel !== 'none') {
      for (const d of DESCRIPTORS) {
        if (d.hwAccel === 'none') continue;
        if (d.hwAccel === preferredHwAccel) continue;
        if (!isUsable(d, source)) continue;
        return d;
      }
    }
    // Pass 3: CPU. Always returns true on `isUsable` for ffmpeg-known
    // codecs, so this branch never falls through.
    return cpuDecoder;
  }
}

/** Full list of compiled-in decoder descriptors, plus the qsv-native
 *  variants which aren't in `DESCRIPTORS` (the resolver skips them
 *  unless an opt-in path requests them by id). Both lists are used by
 *  the boot probe. */
export const ALL_DECODERS: readonly DecoderDescriptor[] = [
  ...DESCRIPTORS,
  h264QsvNativeDecoder,
  hevcQsvNativeDecoder,
  av1QsvNativeDecoder,
];

/** Lookup a qsv-native decoder by source codec — exposed for the
 *  Phase 5 vpp_qsv crop path that bypasses the registry resolver. */
export function findQsvNativeDecoder(
  codec: 'h264' | 'hevc' | 'av1',
): DecoderDescriptor | null {
  switch (codec) {
    case 'h264':
      return h264QsvNativeDecoder;
    case 'hevc':
      return hevcQsvNativeDecoder;
    case 'av1':
      return av1QsvNativeDecoder;
  }
}

export const decoderRegistry: DecoderRegistry = new StaticDecoderRegistry();
