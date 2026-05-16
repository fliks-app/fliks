import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { hevcMain10CodecString, hevcMainCodecString } from '../codec-strings';

/** AMD / Intel-on-Linux VAAPI HEVC SDR encoder (Main 8-bit). Same path as
 *  `h264_vaapi` — used when crop forces VAAPI off the QSV fast lane, and
 *  on AMD GPUs where VAAPI is the only HEVC HW exposure. */
export const hevcVaapi: EncoderDescriptor = {
  id: 'hevc_vaapi',
  hwAccel: 'vaapi',
  variant: { codec: 'hevc', bitDepth: 8, hdr: null },
  supports: () => true,
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => hevcMainCodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, filters } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    const common = [
      '-c:v',
      'hevc_vaapi',
      '-profile:v',
      '1',
      '-b:v',
      bitrate,
      '-maxrate',
      bitrate,
    ];
    const trailing = [
      '-g',
      String(target.gopSize),
      '-keyint_min',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
      '-tag:v',
      'hvc1',
    ];

    if (filters.tonemapVaapi) {
      return [
        ...common,
        '-vf',
        `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-16:extra_hw_frames=24${filters.tonemapVaapi}`,
        ...trailing,
      ];
    }
    if (filters.tonemapOpencl) {
      return [
        ...common,
        '-vf',
        `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-16:extra_hw_frames=24${filters.tonemapOpencl},hwmap=derive_device=vaapi:mode=write:reverse=1,format=vaapi`,
        ...trailing,
      ];
    }
    return [
      ...common,
      '-vf',
      `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-16:format=nv12`,
      ...trailing,
    ];
  },
};

/** VAAPI HEVC Main10 HDR10 encoder. Profile 2 (Main10), p010 surfaces,
 *  BT.2020 + PQ color tags. Mesa VAAPI does not reliably emit the
 *  mastering-display (`mdcv`) / content-light-level (`clli`) SEI on most
 *  drivers — `supportsHdrMetadata()` returns false so the registry falls
 *  back to libx265 for HDR rungs. The builder remains here so a future
 *  Mesa fix only requires flipping the capability bit. */
export const hevcVaapiHdr10: EncoderDescriptor = {
  id: 'hevc_vaapi_main10',
  hwAccel: 'vaapi',
  variant: { codec: 'hevc', bitDepth: 10, hdr: 'HDR10' },
  supports: () => true,
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => hevcMain10CodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, filters } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    return [
      '-c:v',
      'hevc_vaapi',
      '-profile:v',
      '2',
      '-b:v',
      bitrate,
      '-maxrate',
      bitrate,
      '-vf',
      `${filters.hwCropPrefix}scale_vaapi=w=${w}:h=-16:format=p010le`,
      '-g',
      String(target.gopSize),
      '-keyint_min',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
      '-color_primaries',
      'bt2020',
      '-color_trc',
      'smpte2084',
      '-colorspace',
      'bt2020nc',
      '-tag:v',
      'hvc1',
    ];
  },
};

/** VAAPI HEVC Main10 HLG variant — same encoder path as HDR10, only the
 *  transfer characteristic differs. Same Mesa metadata limitation
 *  applies; registry falls back to libx265. */
export const hevcVaapiHlg: EncoderDescriptor = {
  id: 'hevc_vaapi_hlg',
  hwAccel: 'vaapi',
  variant: { codec: 'hevc', bitDepth: 10, hdr: 'HLG' },
  supports: () => true,
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => hevcMain10CodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const args = hevcVaapiHdr10.buildArgs(input);
    const tIdx = args.indexOf('-color_trc');
    if (tIdx !== -1) args[tIdx + 1] = 'arib-std-b67';
    return args;
  },
};
