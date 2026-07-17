import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { h264CodecString } from '../codec-strings';
import { amfScaleFilter8bit } from './helpers/amf-filters';
import { AMF_GOP_ARGS } from './helpers/amf-gop';

/** AMD AMF H.264 encoder (Windows). Fed CPU frames from the d3d11va decode
 *  chain; the encoder uploads and encodes. `-usage transcoding` +
 *  `-quality balanced` are pinned (not split early/main) so the SPS stays
 *  identical across the warm-up and steady-state sessions. */
export const h264Amf: EncoderDescriptor = {
  id: 'h264_amf',
  hwAccel: 'amf',
  variant: { codec: 'h264', bitDepth: 8, hdr: null },
  supports: () => process.platform === 'win32',
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => h264CodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target } = input;
    const bitrate = `${target.videoBitrateBps}`;
    return [
      '-c:v',
      'h264_amf',
      '-usage',
      'transcoding',
      '-profile:v',
      'high',
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
    ];
  },
};
