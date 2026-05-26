import type { CropArea, ExtractArgs, ExtractorBackend } from './types';

/**
 * VAAPI backend — fastest path on Intel / AMD Linux GPUs for the no-crop
 * case. `scale_vaapi` runs the entire pipeline on the GPU, downloading
 * only the final 240px tile. Moving the scale to SW (i.e. downloading the
 * full-res decoded frame first) collapses throughput, so we deliberately
 * leave the crop path to {@link QsvExtractor} which has a HW crop+scale
 * filter (`vpp_qsv`). VAAPI has no equivalent crop-on-surface filter.
 *
 * Benched on Intel Arc A370M / 4K HEVC 10-bit: ~960 ms wall for 10 frames
 * at 4 workers (4.4× the SW path, stable across 4-16 workers).
 */
export class VaapiExtractor implements ExtractorBackend {
  readonly name = 'vaapi';
  constructor(private readonly device: string) {}

  describe(): string {
    return `vaapi(${this.device})`;
  }

  supports(crop?: CropArea): boolean {
    return !crop;
  }

  buildArgs({
    inputPath,
    seekSeconds,
    outputPath,
    thumbWidth,
  }: ExtractArgs): string[] {
    return [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      // Single-thread per ffmpeg: each process only emits one frame so
      // multi-threaded decode adds context-switch overhead without
      // shortening the critical path.
      '-threads',
      '1',
      '-hwaccel',
      'vaapi',
      '-hwaccel_device',
      this.device,
      '-hwaccel_output_format',
      'vaapi',
      // Demuxer-only seek to the nearest keyframe. Sub-second precision
      // is fine for thumbnails and avoids decoding forward.
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
      `scale_vaapi=${thumbWidth}:-2:format=nv12,hwdownload,format=nv12`,
      '-q:v',
      '5',
      '-y',
      outputPath,
    ];
  }
}
