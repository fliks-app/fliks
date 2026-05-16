import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { hevcMain10CodecString, hevcMainCodecString } from '../codec-strings';
import { hdrColorArgs, hlgFromHdr10 } from './helpers/hdr-variants';

/** NVIDIA NVENC HEVC SDR encoder — Maxwell 2nd gen (GM20x) and later.
 *  Tonemap path round-trips via CPU because mainline FFmpeg still has no
 *  tonemap_cuda equivalent; HDR variants below stay on GPU end-to-end. */
export const hevcNvenc: EncoderDescriptor = {
  id: 'hevc_nvenc',
  hwAccel: 'nvenc',
  variant: { codec: 'hevc', bitDepth: 8, hdr: null },
  supports: () => true,
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => hevcMainCodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, nvencPreset, filters, tonemap, hasCrop } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    const common = [
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

    if (tonemap) {
      return [
        ...common,
        '-vf',
        `hwdownload,format=p010le,${filters.cpuCropPrefix}${filters.tonemapCpu}scale=${w}:-2`,
        ...trailing,
      ];
    }
    const nvCropFilter = hasCrop
      ? `hwdownload,format=nv12,${filters.cropStr},hwupload_cuda,`
      : '';
    return [
      ...common,
      '-vf',
      `${nvCropFilter}scale_cuda=w=${w}:h=-2:format=nv12`,
      ...trailing,
    ];
  },
};

/** NVENC HEVC Main10 HDR10 encoder — Pascal (GP10x) and later. NVENC has
 *  emitted the full mastering-display / content-light-level SEI since
 *  the 2019 FFmpeg patch landed, so `supportsHdrMetadata()` is true and
 *  the orchestrator can drive it as the preferred HDR HW path on NV
 *  hardware. */
export const hevcNvencHdr10: EncoderDescriptor = {
  id: 'hevc_nvenc_main10',
  hwAccel: 'nvenc',
  variant: { codec: 'hevc', bitDepth: 10, hdr: 'HDR10' },
  supports: () => true,
  supportsHdrMetadata: () => true,
  codecString: (target: EncoderTarget) => hevcMain10CodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, nvencPreset, filters, hasCrop } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    const nvCropFilter = hasCrop
      ? `hwdownload,format=p010le,${filters.cropStr},hwupload_cuda,`
      : '';
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
      `${nvCropFilter}scale_cuda=w=${w}:h=-2:format=p010le`,
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
