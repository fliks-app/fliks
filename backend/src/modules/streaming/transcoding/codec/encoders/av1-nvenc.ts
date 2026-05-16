import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { av1CodecString } from '../codec-strings';
import { hdrColorArgs } from './helpers/hdr-variants';
import { scaleMod16Height } from './helpers/scale-filter';

/** NVIDIA NVENC AV1 encoder — Ada Lovelace (RTX 4000 series) and later.
 *  Pascal, Turing and Ampere don't ship the AV1 encode unit, so
 *  `supports()` returning true relies on the runtime fallback path
 *  catching the spawn error and downgrading to libsvtav1 there. Tonemap
 *  path round-trips via CPU like h264_nvenc — no tonemap_cuda in
 *  mainline FFmpeg. */
export const av1Nvenc: EncoderDescriptor = {
  id: 'av1_nvenc',
  hwAccel: 'nvenc',
  variant: { codec: 'av1', bitDepth: 8, hdr: null },
  supports: () => true,
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => av1CodecString(target, 8),
  buildArgs(input: EncoderInput): string[] {
    const { target, nvencPreset, filters, tonemap, hasCrop } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    const common = [
      '-c:v', 'av1_nvenc',
      '-preset', nvencPreset,
      '-b:v', bitrate,
      '-maxrate', bitrate,
    ];
    const trailing = [
      '-g', String(target.gopSize),
      '-keyint_min', String(target.gopSize),
      '-force_key_frames', input.forceKeyframesExpr,
    ];

    if (tonemap) {
      return [
        ...common,
        '-vf',
        `hwdownload,format=p010le,${filters.cpuCropPrefix}${filters.tonemapCpu}scale=${w}:${scaleMod16Height(w)}`,
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

/** NVENC AV1 HDR10 — Ada writes the HDR10 static metadata SEI when
 *  `-master_display` and `-max_cll` are passed on the encoder. Static
 *  values match a 1000-nit BT.2020 mastering display with 400-nit MaxFALL,
 *  the common reference for UHD Blu-ray remasters and the dominant
 *  source-side authoring target. */
export const av1NvencHdr10: EncoderDescriptor = {
  id: 'av1_nvenc_hdr10',
  hwAccel: 'nvenc',
  variant: { codec: 'av1', bitDepth: 10, hdr: 'HDR10' },
  supports: () => true,
  supportsHdrMetadata: () => true,
  codecString: (target: EncoderTarget) => av1CodecString(target, 10),
  buildArgs(input: EncoderInput): string[] {
    const { target, nvencPreset } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    return [
      '-c:v', 'av1_nvenc',
      '-pix_fmt', 'p010le',
      '-preset', nvencPreset,
      '-b:v', bitrate,
      '-maxrate', bitrate,
      '-vf',
      `scale_cuda=w=${w}:h=-2:format=p010le`,
      '-g', String(target.gopSize),
      '-keyint_min', String(target.gopSize),
      '-force_key_frames', input.forceKeyframesExpr,
      ...hdrColorArgs('HDR10'),
      '-master_display',
      'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)',
      '-max_cll', '1000,400',
    ];
  },
};

/** NVENC AV1 HLG — same encoder path, only the SPS VUI transfer flag
 *  flips to ARIB STD-B67 and no mastering-display / max_cll is emitted
 *  (HLG signaling is purely in the OETF, no static metadata). */
export const av1NvencHlg: EncoderDescriptor = {
  id: 'av1_nvenc_hlg',
  hwAccel: 'nvenc',
  variant: { codec: 'av1', bitDepth: 10, hdr: 'HLG' },
  supports: () => true,
  supportsHdrMetadata: () => true,
  codecString: (target: EncoderTarget) => av1CodecString(target, 10),
  buildArgs(input: EncoderInput): string[] {
    const { target, nvencPreset } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    return [
      '-c:v', 'av1_nvenc',
      '-pix_fmt', 'p010le',
      '-preset', nvencPreset,
      '-b:v', bitrate,
      '-maxrate', bitrate,
      '-vf',
      `scale_cuda=w=${w}:h=-2:format=p010le`,
      '-g', String(target.gopSize),
      '-keyint_min', String(target.gopSize),
      '-force_key_frames', input.forceKeyframesExpr,
      ...hdrColorArgs('HLG'),
    ];
  },
};
