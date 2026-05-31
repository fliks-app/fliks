import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { av1CodecString } from '../codec-strings';
import { hdrColorArgs } from './helpers/hdr-variants';

/** AMD VAAPI AV1 encoder — RDNA3 (RX 7000) and Ryzen 7000/8000 APUs on
 *  Mesa 23.3+. No `-preset` knob (the VAAPI driver picks rate control
 *  internally; same story as h264_vaapi). Bitrate is passed as raw bps
 *  so VAAPI's parser accepts it directly. */
export const av1Vaapi: EncoderDescriptor = {
  id: 'av1_vaapi',
  hwAccel: 'vaapi',
  variant: { codec: 'av1', bitDepth: 8, hdr: null },
  supports: () => true,
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => av1CodecString(target, 8),
  buildArgs(input: EncoderInput): string[] {
    const { target, filters } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    const common = ['-c:v', 'av1_vaapi', '-b:v', bitrate, '-maxrate', bitrate];
    const trailing = [
      '-g',
      String(target.gopSize),
      '-keyint_min',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
    ];

    if (filters.tonemapVaapi) {
      return [
        ...common,
        '-vf',
        `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-2:extra_hw_frames=24${filters.tonemapVaapi}`,
        ...trailing,
      ];
    }
    if (filters.tonemapOpencl) {
      return [
        ...common,
        '-vf',
        `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-2:extra_hw_frames=24${filters.tonemapOpencl},hwmap=derive_device=vaapi:mode=write:reverse=1,format=vaapi`,
        ...trailing,
      ];
    }
    return [
      ...common,
      '-vf',
      `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-2:format=nv12`,
      ...trailing,
    ];
  },
};

/** AMD VAAPI AV1 HDR10 — `supportsHdrMetadata` is false because Mesa's
 *  AV1 HDR static-metadata emission is still immature (mastering-display
 *  packet writing landed but is not reliably propagated by every driver
 *  version on the support matrix). Registry falls back to libsvtav1 for
 *  the HDR rungs while keeping AV1 SDR on VAAPI. */
export const av1VaapiHdr10: EncoderDescriptor = {
  id: 'av1_vaapi_hdr10',
  hwAccel: 'vaapi',
  variant: { codec: 'av1', bitDepth: 10, hdr: 'HDR10' },
  supports: () => true,
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => av1CodecString(target, 10),
  buildArgs(input: EncoderInput): string[] {
    const { target, filters } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    return [
      '-c:v',
      'av1_vaapi',
      '-b:v',
      bitrate,
      '-maxrate',
      bitrate,
      '-vf',
      `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-2:format=p010le`,
      '-g',
      String(target.gopSize),
      '-keyint_min',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
      ...hdrColorArgs('HDR10'),
    ];
  },
};
