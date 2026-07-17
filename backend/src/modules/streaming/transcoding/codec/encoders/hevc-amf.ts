import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { hevcMain10CodecString, hevcMainCodecString } from '../codec-strings';
import { hdrColorArgs, hlgFromHdr10 } from './helpers/hdr-variants';
import { amfScaleFilter8bit, amfScaleFilter10bit } from './helpers/amf-filters';
import { AMF_GOP_ARGS } from './helpers/amf-gop';

/** AMD AMF HEVC Main 8-bit encoder (Windows). */
export const hevcAmf: EncoderDescriptor = {
  id: 'hevc_amf',
  hwAccel: 'amf',
  variant: { codec: 'hevc', bitDepth: 8, hdr: null },
  supports: () => process.platform === 'win32',
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => hevcMainCodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target } = input;
    const bitrate = `${target.videoBitrateBps}`;
    return [
      '-c:v',
      'hevc_amf',
      '-usage',
      'transcoding',
      '-profile:v',
      'main',
      '-quality',
      'balanced',
      '-rc',
      'cbr',
      '-b:v',
      bitrate,
      '-maxrate',
      bitrate,
      '-vf',
      amfScaleFilter8bit(input),
      ...AMF_GOP_ARGS,
      '-g',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
      '-tag:v',
      'hvc1',
    ];
  },
};

/** AMD AMF HEVC Main10 HDR10 encoder. HDR signaling rides the SPS VUI
 *  `-color_*` tags (AMF carries no mastering-display SEI option), mirroring
 *  the QSV HDR path. */
export const hevcAmfHdr10: EncoderDescriptor = {
  id: 'hevc_amf_main10',
  hwAccel: 'amf',
  variant: { codec: 'hevc', bitDepth: 10, hdr: 'HDR10' },
  supports: () => process.platform === 'win32',
  supportsHdrMetadata: () => true,
  codecString: (target: EncoderTarget) => hevcMain10CodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target } = input;
    const bitrate = `${target.videoBitrateBps}`;
    return [
      '-c:v',
      'hevc_amf',
      '-usage',
      'transcoding',
      '-profile:v',
      'main10',
      '-pix_fmt',
      'p010le',
      '-quality',
      'balanced',
      '-rc',
      'cbr',
      '-b:v',
      bitrate,
      '-maxrate',
      bitrate,
      '-vf',
      amfScaleFilter10bit(input),
      ...AMF_GOP_ARGS,
      '-g',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
      ...hdrColorArgs('HDR10'),
      '-tag:v',
      'hvc1',
    ];
  },
};

/** Same encoder, HLG variant — only the SPS VUI transfer tag differs. */
export const hevcAmfHlg: EncoderDescriptor = hlgFromHdr10(
  'hevc_amf_hlg',
  hevcAmfHdr10,
);
