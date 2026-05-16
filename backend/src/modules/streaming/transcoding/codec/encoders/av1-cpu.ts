import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { av1CodecString } from '../codec-strings';
import { hdrColorArgs } from './helpers/hdr-variants';
import { scaleMod16Height } from './helpers/scale-filter';

/** Maps a named ffmpeg preset onto the SVT-AV1 integer preset namespace
 *  (`0` slowest / highest-quality, `13` fastest). Values picked to match
 *  perceived quality of the libx264 / libx265 namesakes at similar bitrate
 *  targets: `veryfast` stays watchable on weak CPUs, `medium` is a sane
 *  steady-state default, `slow` reserves CPU for VOD style packing. */
function svtAv1Preset(preset: string): string {
  switch (preset) {
    case 'veryfast': return '10';
    case 'faster': return '9';
    case 'fast': return '7';
    case 'slow': return '3';
    case 'medium':
    default: return '5';
  }
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
    const bitrate = `${target.videoBitrateBps}`;
    return [
      '-c:v', 'libsvtav1',
      '-preset', svtAv1Preset(preset),
      '-b:v', bitrate,
      '-maxrate', bitrate,
      '-vf',
      `${filters.cpuCropPrefix}${filters.tonemapCpu}scale=${w}:${scaleMod16Height(w)}:flags=lanczos,format=yuv420p${filters.burnInFilter}`,
      '-g', String(target.gopSize),
      '-keyint_min', String(target.gopSize),
      '-force_key_frames', input.forceKeyframesExpr,
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
    const bitrate = `${target.videoBitrateBps}`;
    return [
      '-c:v', 'libsvtav1',
      '-pix_fmt', 'yuv420p10le',
      '-preset', svtAv1Preset(preset),
      '-b:v', bitrate,
      '-maxrate', bitrate,
      '-svtav1-params',
      'enable-hdr=1:mastering-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):content-light=1000,400',
      '-vf',
      `${filters.cpuCropPrefix}scale=${w}:${scaleMod16Height(w)}:flags=lanczos,format=yuv420p10le`,
      '-g', String(target.gopSize),
      '-keyint_min', String(target.gopSize),
      '-force_key_frames', input.forceKeyframesExpr,
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
    const bitrate = `${target.videoBitrateBps}`;
    return [
      '-c:v', 'libsvtav1',
      '-pix_fmt', 'yuv420p10le',
      '-preset', svtAv1Preset(preset),
      '-b:v', bitrate,
      '-maxrate', bitrate,
      '-svtav1-params',
      'color-primaries=9:transfer-characteristics=18:matrix-coefficients=9',
      '-vf',
      `${filters.cpuCropPrefix}scale=${w}:${scaleMod16Height(w)}:flags=lanczos,format=yuv420p10le`,
      '-g', String(target.gopSize),
      '-keyint_min', String(target.gopSize),
      '-force_key_frames', input.forceKeyframesExpr,
      ...hdrColorArgs('HLG'),
    ];
  },
};
