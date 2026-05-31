import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { av1CodecString } from '../codec-strings';
import { hdrColorArgs } from './helpers/hdr-variants';
import { masterDisplayString, maxCllString } from './helpers/hdr-metadata';
import { scaleEvenHeight } from './helpers/scale-filter';

/** Maps a named ffmpeg preset onto the SVT-AV1 integer preset namespace
 *  (`0` slowest / highest-quality, `13` fastest). Values picked to match
 *  perceived quality of the libx264 / libx265 namesakes at similar bitrate
 *  targets: `veryfast` stays watchable on weak CPUs, `medium` is a sane
 *  steady-state default, `slow` reserves CPU for VOD style packing. */
function svtAv1Preset(preset: string): string {
  switch (preset) {
    case 'veryfast':
      return '10';
    case 'faster':
      return '9';
    case 'fast':
      return '7';
    case 'slow':
      return '3';
    case 'medium':
    default:
      return '5';
  }
}

/** SVT-AV1 in `SVT_AV1_PRED_RANDOM_ACCESS` (the only mode the ffmpeg
 *  wrapper enables for HLS-style segmented output) silently downgrades
 *  CBR → VBR and then strictly requires `maxrate > b:v` — equal values
 *  trip "Max Bitrate must be greater than Target Bitrate" and the
 *  encoder exits 234 before writing any segment (#147). Apply the same
 *  1.5× headroom the master-playlist BANDWIDTH attribute already uses
 *  for VBR-encoded variants, with a 2× buffer matching libx264/libx265
 *  convention. */
function svtAv1Rates(videoBitrateBps: number): {
  bitrate: string;
  maxrate: string;
  bufsize: string;
} {
  const bps = Math.max(1, videoBitrateBps);
  return {
    bitrate: String(bps),
    maxrate: String(Math.round(bps * 1.5)),
    bufsize: String(Math.round(bps * 2)),
  };
}

/** Universal libsvtav1 fallback. Threads use SVT-AV1's auto-detect (no
 *  explicit `-threads` cap — libsvtav1 is tile-parallel and its internal
 *  scheduler is conservative enough that seg-0 latency isn't a problem at
 *  the presets we ship). Reference quality for AV1 HDR is set by this
 *  encoder. */
export const av1Cpu: EncoderDescriptor = {
  id: 'libsvtav1',
  hwAccel: 'none',
  variant: { codec: 'av1', bitDepth: 8, hdr: null },
  supports: () => true,
  supportsHdrMetadata: () => true,
  codecString: (target: EncoderTarget) => av1CodecString(target, 8),
  buildArgs(input: EncoderInput): string[] {
    const { target, preset, filters } = input;
    const w = target.width;
    const { bitrate, maxrate, bufsize } = svtAv1Rates(target.videoBitrateBps);
    return [
      '-c:v',
      'libsvtav1',
      '-preset',
      svtAv1Preset(preset),
      '-b:v',
      bitrate,
      '-maxrate',
      maxrate,
      '-bufsize',
      bufsize,
      '-vf',
      `${filters.cpuCropPrefix}${filters.tonemapCpu}scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=yuv420p${filters.burnInFilter}`,
      '-g',
      String(target.gopSize),
      '-keyint_min',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
    ];
  },
};

/** libsvtav1 HDR10 — `enable-hdr=1` plus the same 1000-nit BT.2020
 *  mastering-display geometry NVENC writes, threaded through SVT-AV1's
 *  own `-svtav1-params` channel. ffmpeg-side `-color_*` flags are kept
 *  in lockstep so the SPS VUI matches the OBU metadata. */
export const av1CpuHdr10: EncoderDescriptor = {
  id: 'libsvtav1_hdr10',
  hwAccel: 'none',
  variant: { codec: 'av1', bitDepth: 10, hdr: 'HDR10' },
  supports: () => true,
  supportsHdrMetadata: () => true,
  codecString: (target: EncoderTarget) => av1CodecString(target, 10),
  buildArgs(input: EncoderInput): string[] {
    const { target, preset, filters } = input;
    const w = target.width;
    const { bitrate, maxrate, bufsize } = svtAv1Rates(target.videoBitrateBps);
    return [
      '-c:v',
      'libsvtav1',
      '-pix_fmt',
      'yuv420p10le',
      '-preset',
      svtAv1Preset(preset),
      '-b:v',
      bitrate,
      '-maxrate',
      maxrate,
      '-bufsize',
      bufsize,
      '-svtav1-params',
      `enable-hdr=1:mastering-display=${masterDisplayString(input.hdrMetadata)}:content-light=${maxCllString(input.hdrMetadata)}`,
      '-vf',
      `${filters.cpuCropPrefix}scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=yuv420p10le${filters.burnInFilter}`,
      '-g',
      String(target.gopSize),
      '-keyint_min',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
      ...hdrColorArgs('HDR10'),
    ];
  },
};

/** libsvtav1 HLG — color signaling lives entirely in `-svtav1-params`
 *  (color-primaries=9 BT.2020, transfer-characteristics=18 ARIB STD-B67,
 *  matrix-coefficients=9 BT.2020 NCL). Doubled in ffmpeg `-color_*` for
 *  symmetry with the HDR10 path. No mastering-display — HLG is metadata-
 *  free by design. */
export const av1CpuHlg: EncoderDescriptor = {
  id: 'libsvtav1_hlg',
  hwAccel: 'none',
  variant: { codec: 'av1', bitDepth: 10, hdr: 'HLG' },
  supports: () => true,
  supportsHdrMetadata: () => true,
  codecString: (target: EncoderTarget) => av1CodecString(target, 10),
  buildArgs(input: EncoderInput): string[] {
    const { target, preset, filters } = input;
    const w = target.width;
    const { bitrate, maxrate, bufsize } = svtAv1Rates(target.videoBitrateBps);
    return [
      '-c:v',
      'libsvtav1',
      '-pix_fmt',
      'yuv420p10le',
      '-preset',
      svtAv1Preset(preset),
      '-b:v',
      bitrate,
      '-maxrate',
      maxrate,
      '-bufsize',
      bufsize,
      '-svtav1-params',
      'color-primaries=9:transfer-characteristics=18:matrix-coefficients=9',
      '-vf',
      `${filters.cpuCropPrefix}scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=yuv420p10le${filters.burnInFilter}`,
      '-g',
      String(target.gopSize),
      '-keyint_min',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
      ...hdrColorArgs('HLG'),
    ];
  },
};
