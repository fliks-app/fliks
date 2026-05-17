import type { EncoderDescriptor, EncoderInput, EncoderTarget } from '../types';
import { hevcMain10CodecString, hevcMainCodecString } from '../codec-strings';
import { hdrColorArgs, hlgFromHdr10 } from './helpers/hdr-variants';
import { scaleMod16Height } from './helpers/scale-filter';

/** Apple VideoToolbox HEVC SDR encoder — Mac 2017+ (T2 / Apple Silicon).
 *  VT decode emits CPU-backed buffers, so the filter chain mirrors the
 *  H.264 VT path: software scale + lanczos + yuv420p, with optional
 *  burn-in subtitles spliced after `format=yuv420p`. */
export const hevcVideotoolbox: EncoderDescriptor = {
  id: 'hevc_videotoolbox',
  hwAccel: 'videotoolbox',
  variant: { codec: 'hevc', bitDepth: 8, hdr: null },
  supports: () => true,
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => hevcMainCodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, early, filters, tonemap, hasBurnIn, hasCrop } = input;
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

    if (tonemap && !hasBurnIn && !hasCrop) {
      // Full Metal pipeline: scale_vt does HDR→SDR tonemap on the
      // Apple Media Engine. Avoids CPU round-trip when burn-in /
      // crop aren't requested.
      return [
        ...common,
        '-vf',
        `scale_vt=w=${w}:h=-2:color_matrix=bt709:color_primaries=bt709:color_transfer=bt709`,
        ...trailing,
      ];
    }
    return [
      ...common,
      '-vf',
      `${filters.cpuCropPrefix}${filters.tonemapCpu}scale=${w}:${scaleMod16Height(w)}:flags=lanczos,format=yuv420p${filters.burnInFilter}`,
      ...trailing,
    ];
  },
};

/** VT HEVC Main10 HDR10. The builder is implemented end-to-end, but
 *  `hevc_videotoolbox` has a documented history of silently degrading
 *  Main10 inputs to 8-bit on some FFmpeg builds (lisamelton report
 *  #106). Until the silent-fallback fix lands and ships in our pinned
 *  FFmpeg, `supportsHdrMetadata()` returns false so the registry routes
 *  HDR rungs to libx265 on Apple platforms. */
export const hevcVideotoolboxHdr10: EncoderDescriptor = {
  id: 'hevc_videotoolbox_main10',
  hwAccel: 'videotoolbox',
  variant: { codec: 'hevc', bitDepth: 10, hdr: 'HDR10' },
  supports: () => true,
  supportsHdrMetadata: () => false,
  codecString: (target: EncoderTarget) => hevcMain10CodecString(target),
  buildArgs(input: EncoderInput): string[] {
    const { target, early, filters } = input;
    const w = target.width;
    const bitrate = `${target.videoBitrateBps}`;
    return [
      '-c:v',
      'hevc_videotoolbox',
      '-profile:v',
      'main10',
      ...(early ? ['-realtime', '1'] : []),
      '-pix_fmt',
      'p010le',
      '-b:v',
      bitrate,
      '-maxrate',
      bitrate,
      '-vf',
      `${filters.cpuCropPrefix}scale=${w}:${scaleMod16Height(w)}:flags=lanczos,format=p010le`,
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

/** VT HEVC Main10 HLG variant — same silent-fallback caveat as HDR10. */
export const hevcVideotoolboxHlg: EncoderDescriptor = hlgFromHdr10(
  'hevc_videotoolbox_hlg',
  hevcVideotoolboxHdr10,
);
