import type { DecoderDescriptor } from './types';
import type { VideoCodec } from '../types';
import { vaapiDeviceInitArgs } from '../../hw-device';

/** VAAPI decode — universal Linux path. Output surfaces stay in VAAPI
 *  memory until either the encoder consumes them (h264_vaapi / hevc_vaapi
 *  / av1_vaapi) or a bridge filter (`hwmap` or `hwdownload`) reroutes
 *  them. */
function vaapiDecoder(
  codec: VideoCodec,
  maxBitDepth: 8 | 10,
): DecoderDescriptor {
  return {
    id: `${codec}_vaapi_decode`,
    hwAccel: 'vaapi',
    sourceCodec: codec,
    maxBitDepth,
    outputSurface: 'vaapi',
    supports: () => true,
    buildInputArgs: () => [
      ...vaapiDeviceInitArgs(),
      '-filter_hw_device',
      'va',
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

export const h264VaapiDecoder = vaapiDecoder('h264', 8);
export const hevcVaapiDecoder = vaapiDecoder('hevc', 10);
export const av1VaapiDecoder = vaapiDecoder('av1', 10);
