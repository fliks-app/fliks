import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { hevcMain10CodecString, hevcMainCodecString } from '../codec-strings';
import { hdrColorArgs } from './helpers/hdr-variants';
import { masterDisplayString, maxCllString } from './helpers/hdr-metadata';
import { scaleEvenHeight } from './helpers/scale-filter';

/** Universal libx265 HEVC SDR fallback. Same thread cap as libx264 (4):
 *  first-segment latency stays bounded because the frame thread pool
 *  pre-buffers ~`threads-1` frames before emitting output. Preset
 *  namespace is shared with libx264 (`veryfast..slow`) so the
 *  orchestrator's preset string maps 1:1. */
export const hevcCpu: EncoderDescriptor = {
  id: 'libx265',
  hwAccel: 'none',
  variant: { codec: 'hevc', bitDepth: 8, hdr: null },
  supports: () => true,
  supportsHdrMetadata: () => true,
  codecString: (target: EncoderTarget) => hevcMainCodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, preset, filters, libx264BufsizeMb } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    return [
      '-c:v',
      'libx265',
      '-threads:v',
      '4',
      '-preset',
      preset,
      '-b:v',
      bitrate,
      '-maxrate',
      bitrate,
      '-bufsize',
      libx264BufsizeMb,
      '-vf',
      `${filters.cpuCropPrefix}${filters.tonemapCpu}scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=yuv420p${filters.burnInFilter}`,
      '-g',
      String(target.gopSize),
      '-keyint_min',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
      '-forced-idr',
      '1',
      // x265's default open-gop=1 still emits CRA (not IDR) on a frame forced
      // via pict_type alone; -forced-idr only takes effect with closed GOPs.
      '-x265-params',
      'open-gop=0',
      '-tag:v',
      'hvc1',
    ];
  },
};

/** libx265 HEVC Main10 HDR10 — universal CPU fallback for HDR rungs
 *  whenever the platform's HW path either can't emit Main10 or can't
 *  write the `mdcv` / `clli` SEI reliably. `hdr-opt=1` enables PQ
 *  optimisations, `repeat-headers=1` keeps each segment self-decodable
 *  without dragging in the previous segment's parameter sets. */
export const hevcCpuHdr10: EncoderDescriptor = {
  id: 'libx265_main10',
  hwAccel: 'none',
  variant: { codec: 'hevc', bitDepth: 10, hdr: 'HDR10' },
  supports: () => true,
  supportsHdrMetadata: () => true,
  codecString: (target: EncoderTarget) => hevcMain10CodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, preset, filters, libx264BufsizeMb } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    const x265Params = [
      'hdr-opt=1',
      'repeat-headers=1',
      // See hevcCpu: open-gop=0 is required for -forced-idr to emit a true IDR.
      'open-gop=0',
      'colorprim=bt2020',
      'transfer=smpte2084',
      'colormatrix=bt2020nc',
      `master-display=${masterDisplayString(input.hdrMetadata)}`,
      `max-cll=${maxCllString(input.hdrMetadata)}`,
    ].join(':');
    return [
      '-c:v',
      'libx265',
      '-threads:v',
      '4',
      '-preset',
      preset,
      '-pix_fmt',
      'yuv420p10le',
      '-b:v',
      bitrate,
      '-maxrate',
      bitrate,
      '-bufsize',
      libx264BufsizeMb,
      '-vf',
      `${filters.cpuCropPrefix}scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=yuv420p10le${filters.burnInFilter}`,
      '-g',
      String(target.gopSize),
      '-keyint_min',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
      '-forced-idr',
      '1',
      '-x265-params',
      x265Params,
      ...hdrColorArgs('HDR10'),
      '-tag:v',
      'hvc1',
    ];
  },
};

/** libx265 HEVC Main10 HLG. HLG has no mastering-display SEI, so the
 *  params shrink to just primaries + transfer + matrix. */
export const hevcCpuHlg: EncoderDescriptor = {
  id: 'libx265_hlg',
  hwAccel: 'none',
  variant: { codec: 'hevc', bitDepth: 10, hdr: 'HLG' },
  supports: () => true,
  supportsHdrMetadata: () => true,
  codecString: (target: EncoderTarget) => hevcMain10CodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, preset, filters, libx264BufsizeMb } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    const x265Params = [
      'repeat-headers=1',
      'open-gop=0',
      'colorprim=bt2020',
      'transfer=arib-std-b67',
      'colormatrix=bt2020nc',
    ].join(':');
    return [
      '-c:v',
      'libx265',
      '-threads:v',
      '4',
      '-preset',
      preset,
      '-pix_fmt',
      'yuv420p10le',
      '-b:v',
      bitrate,
      '-maxrate',
      bitrate,
      '-bufsize',
      libx264BufsizeMb,
      '-vf',
      `${filters.cpuCropPrefix}scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=yuv420p10le${filters.burnInFilter}`,
      '-g',
      String(target.gopSize),
      '-keyint_min',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
      '-forced-idr',
      '1',
      '-x265-params',
      x265Params,
      ...hdrColorArgs('HLG'),
      '-tag:v',
      'hvc1',
    ];
  },
};
