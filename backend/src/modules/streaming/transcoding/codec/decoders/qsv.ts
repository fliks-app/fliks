import type { DecoderDescriptor } from './types';
import type { VideoCodec } from '../types';
import { qsvDeviceInitArgs, qsvViaD3d11DeviceInitArgs } from '../../hw-device';

/** QSV decoder: native VAAPI, never the `-hwaccel qsv` wrapper (drops the
 *  Dolby Vision RPU, fails outright on AV1). `native` only changes the id and
 *  `outputSurface` label the `vpp_qsv` crop/scale path looks up by; the argv
 *  is identical either way. */
function qsvDecoder(
  codec: VideoCodec,
  maxBitDepth: 8 | 10,
  native: boolean,
): DecoderDescriptor {
  return {
    id: `${codec}_qsv${native ? '_native' : ''}_decode`,
    hwAccel: 'qsv',
    sourceCodec: codec,
    maxBitDepth,
    outputSurface: native ? 'qsv' : 'vaapi',
    // VAAPI-backed QSV: Linux-only. win32 QSV always uses qsvD3d11Decoder below.
    supports: () => process.platform !== 'win32',
    buildInputArgs: () => [
      ...qsvDeviceInitArgs(),
      // 'qs' (not 'va'): subtitle burn-in's bare hwupload (no explicit
      // derive_device=) needs the default filter device to be the encoder's.
      '-filter_hw_device',
      'qs',
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

/** Windows QSV decoder: D3D11VA, deriving QSV from the same device
 *  (`qsv=qs@dx`). {@link qsvDecoder} is Linux-only (derives from a VAAPI
 *  device Windows doesn't have), so this is the QSV encode-path decoder there. */
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

export const h264QsvDecoder = qsvDecoder('h264', 8, false);
export const hevcQsvDecoder = qsvDecoder('hevc', 10, false);
export const av1QsvDecoder = qsvDecoder('av1', 10, false);

export const h264QsvNativeDecoder = qsvDecoder('h264', 8, true);
export const hevcQsvNativeDecoder = qsvDecoder('hevc', 10, true);
export const av1QsvNativeDecoder = qsvDecoder('av1', 10, true);

export const h264QsvD3d11Decoder = qsvD3d11Decoder('h264', 8);
export const hevcQsvD3d11Decoder = qsvD3d11Decoder('hevc', 10);
export const av1QsvD3d11Decoder = qsvD3d11Decoder('av1', 10);
