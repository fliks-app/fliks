import type { DecoderDescriptor } from './types';
import type { VideoCodec } from '../types';
import { qsvDeviceInitArgs, qsvViaD3d11DeviceInitArgs } from '../../hw-device';

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

/** QSV-native decoder variant (Linux) — decodes on the iGPU (derived from
 *  VAAPI) and emits `qsv` surfaces the `vpp_qsv` encoder chain consumes
 *  directly, no hwmap. Selected by the vpp_qsv crop / scale paths. Windows
 *  uses {@link qsvD3d11Decoder} instead (see there for why). */
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
    supports: () => process.platform !== 'win32',
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

/** Windows QSV decoder — decodes on **D3D11VA** and derives QSV from the same
 *  D3D11 device (`qsv=qs@dx`). The frame lands as a `d3d11` surface; the QSV
 *  encoder filter maps it onto the QSV device (`hwmap=derive_device=qsv`)
 *  before `vpp_qsv`. Distinct from the native `-hwaccel qsv` decode
 *  ({@link qsvNativeDecoder}), which is avoided on Windows because its AV1 path
 *  fails on Intel/oneVPL for real streams (the tiny boot probe passes, a real
 *  2160p AV1 exits `-17`) while D3D11VA decode is solid. Pairs with the QSV
 *  encoders (`hwAccel: 'qsv'`). Windows-only. */
function qsvD3d11Decoder(
  codec: VideoCodec,
  maxBitDepth: 8 | 10,
): DecoderDescriptor {
  return {
    id: `${codec}_qsv_d3d11_decode`,
    hwAccel: 'qsv',
    sourceCodec: codec,
    maxBitDepth,
    outputSurface: 'd3d11',
    supports: () => process.platform === 'win32',
    buildInputArgs: () => [
      ...qsvViaD3d11DeviceInitArgs(),
      '-filter_hw_device',
      'qs',
      '-hwaccel',
      'd3d11va',
      '-hwaccel_output_format',
      'd3d11',
      '-hwaccel_device',
      'dx',
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

export const h264QsvD3d11Decoder = qsvD3d11Decoder('h264', 8);
export const hevcQsvD3d11Decoder = qsvD3d11Decoder('hevc', 10);
export const av1QsvD3d11Decoder = qsvD3d11Decoder('av1', 10);
