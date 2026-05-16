import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { hevcMain10CodecString, hevcMainCodecString } from '../codec-strings';
import { hdrColorArgs } from './helpers/hdr-variants';
import { scaleMod16Height } from './helpers/scale-filter';

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
    const { target, preset, filters } = input;
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
      '-vf',
      `${filters.cpuCropPrefix}${filters.tonemapCpu}scale=${w}:${scaleMod16Height(w)}:flags=lanczos,format=yuv420p${filters.burnInFilter}`,
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

/** Reference HDR10 master-display string for `x265-params`. The values
 *  describe a BT.2020 display mastered at 1000-nit peak / 0.0001-nit
 *  black point — a sane default for a home-server that re-encodes from
 *  consumer HDR sources without per-title color analysis. Units follow
 *  x265's convention: chromaticities are `0.00002`-step integers and
 *  luminance is `0.0001 cd/m2`. */
const X265_MASTER_DISPLAY =
  'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)';

/** Default MaxCLL / MaxFALL — 1000 / 400 nits. Reasonable HDR10 envelope
 *  for streaming-grade content; conservative enough that downstream
 *  displays don't see clipped highlights. */
const X265_MAX_CLL = '1000,400';

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
    const { target, preset, filters } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    const x265Params = [
      'hdr-opt=1',
      'repeat-headers=1',
      'colorprim=bt2020',
      'transfer=smpte2084',
      'colormatrix=bt2020nc',
      `master-display=${X265_MASTER_DISPLAY}`,
      `max-cll=${X265_MAX_CLL}`,
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
      '-vf',
      `${filters.cpuCropPrefix}scale=${w}:${scaleMod16Height(w)}:flags=lanczos,format=yuv420p10le${filters.burnInFilter}`,
      '-g',
      String(target.gopSize),
      '-keyint_min',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
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
    const { target, preset, filters } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    const x265Params = [
      'repeat-headers=1',
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
      '-vf',
      `${filters.cpuCropPrefix}scale=${w}:${scaleMod16Height(w)}:flags=lanczos,format=yuv420p10le${filters.burnInFilter}`,
      '-g',
      String(target.gopSize),
      '-keyint_min',
      String(target.gopSize),
      '-force_key_frames',
      input.forceKeyframesExpr,
      '-x265-params',
      x265Params,
      ...hdrColorArgs('HLG'),
      '-tag:v',
      'hvc1',
    ];
  },
};
