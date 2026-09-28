import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { hevcMain10CodecString, hevcMainCodecString } from '../codec-strings';
import { hdrColorArgs, hlgFromHdr10 } from './helpers/hdr-variants';
import { vaapiWritesHdrMetadata } from '../encoder-probe';
import {
  vaapiScaleFilter8bit,
  vaapiScaleFilter10bit,
} from './helpers/vaapi-filters';

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
    const { target } = input;
    const bitrate = `${target.videoBitrateBps}`;
    return [
      '-c:v',
      'hevc_vaapi',
      '-profile:v',
      '1',
      '-b:v',
      bitrate,
      '-maxrate',
      bitrate,
      '-vf',
      vaapiScaleFilter8bit(input),
      '-g',
      String(target.gopSize),
      '-keyint_min',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
      '-tag:v',
      'hvc1',
    ];
  },
};

/** VAAPI HEVC Main10 HDR10 encoder. Profile 2 (Main10), p010 surfaces,
 *  BT.2020 + PQ color tags. `supportsHdrMetadata` reads the boot probe's VAAPI driver check. */
export const hevcVaapiHdr10: EncoderDescriptor = {
  id: 'hevc_vaapi_main10',
  hwAccel: 'vaapi',
  variant: { codec: 'hevc', bitDepth: 10, hdr: 'HDR10' },
  supports: () => true,
  supportsHdrMetadata: () => vaapiWritesHdrMetadata(),
  codecString: (target: EncoderTarget) => hevcMain10CodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target } = input;
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
      vaapiScaleFilter10bit(input),
      '-g',
      String(target.gopSize),
      '-keyint_min',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
      ...hdrColorArgs('HDR10'),
      '-tag:v',
      'hvc1',
    ];
  },
};

/** VAAPI HEVC Main10 HLG variant, same path as HDR10 with the transfer
 *  characteristic flipped; shares the HDR10 sibling's probed `supportsHdrMetadata`. */
export const hevcVaapiHlg: EncoderDescriptor = hlgFromHdr10(
  'hevc_vaapi_hlg',
  hevcVaapiHdr10,
);
