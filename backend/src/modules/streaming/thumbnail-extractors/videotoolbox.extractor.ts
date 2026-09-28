import { tonemapChain } from './tonemap';
import type { CropArea, ExtractArgs, ExtractorBackend } from './types';

/**
 * VideoToolbox backend — Apple's HW decode API, used on macOS / Apple
 * Silicon (M-series). Selected by the factory only when running on
 * `darwin`. Not benched in our Linux dev environment; ffmpeg's
 * VideoToolbox accelerator handles HEVC / H.264 / ProRes / AV1 on
 * recent SoCs.
 *
 * Notes:
 *   • `scale_vt` exists and is used by the streaming encode path, but a
 *     single throwaway thumbnail frame isn't worth its HW-frame plumbing:
 *     crop+scale run on the CPU after download, and decode dominates cost
 *     regardless; even pure-SW scale on a 4K frame is sub-millisecond.
 *   • Single-threaded ffmpegs again — one frame per process.
 */
export class VideoToolboxExtractor implements ExtractorBackend {
  readonly name = 'videotoolbox';

  describe(): string {
    return 'videotoolbox';
  }

  supports(_crop?: CropArea): boolean {
    return true;
  }

  buildArgs({
    inputPath,
    seekSeconds,
    outputPath,
    crop,
    thumbWidth,
    hdr,
  }: ExtractArgs): string[] {
    const scale = hdr ? tonemapChain(thumbWidth) : `scale=${thumbWidth}:-1`;
    const vf = crop
      ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},${scale}`
      : scale;
    return [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      '1',
      '-hwaccel',
      'videotoolbox',
      '-noaccurate_seek',
      '-ss',
      String(seekSeconds),
      '-an',
      '-sn',
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-vf',
      vf,
      '-q:v',
      '5',
      '-y',
      outputPath,
    ];
  }
}
