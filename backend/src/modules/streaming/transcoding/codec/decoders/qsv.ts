import type { DecoderDescriptor } from './types';
import type { VideoCodec } from '../types';
import { qsvDeviceInitArgs } from '../../hw-device';

/** Build a QSV decoder descriptor for `codec`. Decode actually happens
 *  on the VAAPI driver (Linux Intel) — libavcodec wires the qsv encoder
 *  on top via the `qsv=qs@va` device that derives a QSV context from
 *  the VAAPI one. Frames hit the filter chain as VAAPI surfaces, which
 *  is what the existing `scale_vaapi → hwmap=qsv` encoder chains
 *  expect. The 'qsv'-encoder native vpp_qsv crop path takes a
 *  different decoder variant (see qsvNative below) so this default
 *  one stays drop-in compatible. */
function qsvDecoder(codec: VideoCodec, maxBitDepth: 8 | 10): DecoderDescriptor {
  return {
    id: `${codec}_qsv_decode`,
    hwAccel: 'qsv',
    sourceCodec: codec,
    maxBitDepth,
    // 'vaapi' rather than 'qsv': the decoder produces VAAPI surfaces
    // that the qsv encoder filter chain hwmap's into qsv format. The
    // qsv-native variant below emits QSV surfaces directly for chains
    // (e.g. vpp_qsv crop) that consume them without hwmap.
    outputSurface: 'vaapi',
    // VAAPI-output QSV path: Linux-only (no VAAPI on Windows). win32 QSV
    // always goes through qsvNativeDecoder below.
    supports: () => process.platform !== 'win32',
    buildInputArgs: () => [
      ...qsvDeviceInitArgs(),
      '-hwaccel',
      'vaapi',
      '-hwaccel_output_format',
      'vaapi',
      '-hwaccel_device',
      'va',
      '-extra_hw_frames',
      '32',
      '-noautorotate',
    ],
  };
}

/** QSV-native decoder variant — same iGPU but emits QSV surfaces
 *  directly. Selected by `vpp_qsv` crop / scale paths that consume
 *  QSV surfaces; the default qsv decoder above stays VAAPI-output for
 *  compatibility with the scale_vaapi-based encoder chains. */
function qsvNativeDecoder(
  codec: VideoCodec,
  maxBitDepth: 8 | 10,
): DecoderDescriptor {
  return {
    id: `${codec}_qsv_native_decode`,
    hwAccel: 'qsv',
    sourceCodec: codec,
    maxBitDepth,
    outputSurface: 'qsv',
    supports: () => true,
    buildInputArgs: () => [
      ...qsvDeviceInitArgs(),
      '-filter_hw_device',
      'qs',
      '-hwaccel',
      'qsv',
      '-hwaccel_output_format',
      'qsv',
      '-hwaccel_device',
      'qs',
      '-extra_hw_frames',
      '32',
      '-noautorotate',
    ],
  };
}

export const h264QsvDecoder = qsvDecoder('h264', 8);
export const hevcQsvDecoder = qsvDecoder('hevc', 10);
export const av1QsvDecoder = qsvDecoder('av1', 10);

export const h264QsvNativeDecoder = qsvNativeDecoder('h264', 8);
export const hevcQsvNativeDecoder = qsvNativeDecoder('hevc', 10);
export const av1QsvNativeDecoder = qsvNativeDecoder('av1', 10);
