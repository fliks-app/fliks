import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { hevcMain10CodecString, hevcMainCodecString } from '../codec-strings';
import { hdrColorArgs, hlgFromHdr10 } from './helpers/hdr-variants';
import {
  nvencScaleFilter10bit,
  nvencScaleFilter8bit,
} from './helpers/nvenc-filters';
import { NVENC_GOP_ARGS } from './helpers/nvenc-gop';

/** NVIDIA NVENC HEVC SDR encoder — Maxwell 2nd gen (GM20x) and later.
 *  Tone-maps via `tonemap_cuda` (GPU, zero-copy) when probed, else CPU/OpenCL;
 *  HDR variants below stay on GPU end-to-end (no tonemap, HDR is preserved). */
export const hevcNvenc: EncoderDescriptor = {
  id: 'hevc_nvenc',
  hwAccel: 'nvenc',
  variant: { codec: 'hevc', bitDepth: 8, hdr: null },
  supports: () => true,
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => hevcMainCodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, nvencPreset } = input;
    const bitrate = `${target.videoBitrateBps}`;
    return [
      '-c:v',
      'hevc_nvenc',
      '-preset',
      nvencPreset,
      '-profile:v',
      'main',
      '-b:v',
      bitrate,
      '-maxrate',
      bitrate,
      '-vf',
      nvencScaleFilter8bit(input),
      ...NVENC_GOP_ARGS,
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

/** NVENC HEVC Main10 HDR10 encoder; Pascal (GP10x) and later. No
 *  `-master_display`/`-max_cll` option; NVENC reads HDR10 metadata from the AVFrame side data. */
export const hevcNvencHdr10: EncoderDescriptor = {
  id: 'hevc_nvenc_main10',
  hwAccel: 'nvenc',
  variant: { codec: 'hevc', bitDepth: 10, hdr: 'HDR10' },
  supports: () => true,
  supportsHdrMetadata: () => true,
  codecString: (target: EncoderTarget) => hevcMain10CodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, nvencPreset } = input;
    const bitrate = `${target.videoBitrateBps}`;
    return [
      '-c:v',
      'hevc_nvenc',
      '-preset',
      nvencPreset,
      '-profile:v',
      'main10',
      '-pix_fmt',
      'p010le',
      '-b:v',
      bitrate,
      '-maxrate',
      bitrate,
      '-vf',
      nvencScaleFilter10bit(input),
      ...NVENC_GOP_ARGS,
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

/** NVENC HEVC Main10 HLG variant — identical to HDR10 with `arib-std-b67`
 *  for the transfer tag. */
export const hevcNvencHlg: EncoderDescriptor = hlgFromHdr10(
  'hevc_nvenc_hlg',
  hevcNvencHdr10,
);
