import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { hevcMain10CodecString, hevcMainCodecString } from '../codec-strings';
import { hdrColorArgs, hlgFromHdr10 } from './helpers/hdr-variants';
import { scaleEvenHeight } from './helpers/scale-filter';
import { vtTonemapFilter } from './helpers/vt-filters';

/** Apple VideoToolbox HEVC SDR encoder; Mac 2017+ (T2 / Apple Silicon).
 *  Tone-maps on the Metal surface when eligible, else falls back to CPU. */
export const hevcVideotoolbox: EncoderDescriptor = {
  id: 'hevc_videotoolbox',
  hwAccel: 'videotoolbox',
  variant: { codec: 'hevc', bitDepth: 8, hdr: null },
  supports: () => true,
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => hevcMainCodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, early, filters, inputSurface } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    const common = [
      '-c:v',
      'hevc_videotoolbox',
      '-profile:v',
      'main',
      ...(early ? ['-realtime', '1'] : []),
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
    // Metal fast path: crop and no-base DV still stay on the VT surface
    // (tonemap_videotoolbox); only burn-in forces the CPU chain below.
    if (inputSurface === 'videotoolbox') {
      return [...common, '-vf', vtTonemapFilter(input), ...trailing];
    }
    // CPU fallback: burn-in, SDR passthrough, or a decoder with no VT surface.
    return [
      ...common,
      '-vf',
      `${filters.cpuCropPrefix}${filters.tonemapCpu}scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=yuv420p${filters.burnInFilter}`,
      ...trailing,
    ];
  },
};

/** VT HEVC Main10 HDR10; Mac 2017+ (T2 / Apple Silicon). `hevc_videotoolbox`
 *  has no `-master_display`/`-max_cll` option; it carries the source's HDR10
 *  static metadata through from the input AVFrame side data instead. */
export const hevcVideotoolboxHdr10: EncoderDescriptor = {
  id: 'hevc_videotoolbox_main10',
  hwAccel: 'videotoolbox',
  variant: { codec: 'hevc', bitDepth: 10, hdr: 'HDR10' },
  supports: () => true,
  supportsHdrMetadata: () => true,
  codecString: (target: EncoderTarget) => hevcMain10CodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, early, filters, inputSurface, tonemap } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    const onMetal = inputSurface === 'videotoolbox';
    // No RPU-aware tonemap exists here (dvNoBaseHdr10PathSupported excludes
    // videotoolbox): the plain scale would tag untouched pixels as HDR10.
    if (tonemap) {
      throw new Error('hevc_videotoolbox_main10: tonemap requested but not supported');
    }
    // Metal fast path: scale_vt resizes the p010 IOSurface in place, HDR
    // tags untouched, instead of a CPU `format=p010le` scale.
    const vf = onMetal
      ? `scale_vt=w=${w}:h=-2`
      : `${filters.cpuCropPrefix}scale=${w}:${scaleEvenHeight(w)}:flags=lanczos,format=p010le${filters.burnInFilter}`;
    return [
      '-c:v',
      'hevc_videotoolbox',
      '-profile:v',
      'main10',
      ...(early ? ['-realtime', '1'] : []),
      // scale_vt's IOSurface output is already p010; -pix_fmt there fights
      // the videotoolbox_vld chain instead of describing a CPU frame.
      ...(onMetal ? [] : ['-pix_fmt', 'p010le']),
      '-b:v',
      bitrate,
      '-maxrate',
      bitrate,
      '-vf',
      vf,
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

/** VT HEVC Main10 HLG variant; same encoder path as HDR10, only the
 *  transfer characteristic differs. */
export const hevcVideotoolboxHlg: EncoderDescriptor = hlgFromHdr10(
  'hevc_videotoolbox_hlg',
  hevcVideotoolboxHdr10,
);
