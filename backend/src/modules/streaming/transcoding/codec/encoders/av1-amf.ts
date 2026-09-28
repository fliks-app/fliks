import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { av1CodecString } from '../codec-strings';
import { hdrColorArgs, hlgFromHdr10 } from './helpers/hdr-variants';
import { amfScaleFilter8bit, amfScaleFilter10bit } from './helpers/amf-filters';
import { AMF_GOP_ARGS } from './helpers/amf-gop';

/** AMD AMF AV1 encoder — RDNA3 (RX 7000) and later. Older GPUs lack the
 *  AV1 encode unit; the runtime fallback catches the spawn error and drops
 *  to libsvtav1. */
export const av1Amf: EncoderDescriptor = {
  id: 'av1_amf',
  hwAccel: 'amf',
  variant: { codec: 'av1', bitDepth: 8, hdr: null },
  supports: () => process.platform === 'win32',
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => av1CodecString(target, 8),
  buildArgs(input: EncoderInput): string[] {
    const { target } = input;
    const bitrate = `${target.videoBitrateBps}`;
    return [
      '-c:v',
      'av1_amf',
      '-usage',
      'transcoding',
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

/** AMF AV1 HDR10, same HDR metadata contract as the HEVC descriptor:
 *  amfenc.c reads mastering-display/CLL side data off the frame (PQ transfer only). */
export const av1AmfHdr10: EncoderDescriptor = {
  id: 'av1_amf_hdr10',
  hwAccel: 'amf',
  variant: { codec: 'av1', bitDepth: 10, hdr: 'HDR10' },
  supports: () => process.platform === 'win32',
  supportsHdrMetadata: () => true,
  codecString: (target: EncoderTarget) => av1CodecString(target, 10),
  buildArgs(input: EncoderInput): string[] {
    const { target, inputSurface } = input;
    const bitrate = `${target.videoBitrateBps}`;
    return [
      '-c:v',
      'av1_amf',
      '-usage',
      'transcoding',
      // d3d11 is a hw pix_fmt already; pinning a software one forces an
      // impossible auto-convert (same failure shape as av1_qsv/format=qsv).
      ...(inputSurface === 'd3d11' ? [] : ['-pix_fmt', 'p010le']),
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
    ];
  },
};

/** AMF AV1 HLG — same encoder path, only the transfer tag flips. */
export const av1AmfHlg: EncoderDescriptor = hlgFromHdr10(
  'av1_amf_hlg',
  av1AmfHdr10,
);
