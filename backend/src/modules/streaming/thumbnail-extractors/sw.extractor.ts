import type { CropArea, ExtractArgs, ExtractorBackend } from './types';

/**
 * Software backend — always-available fallback when no HW device is
 * exposed (no `/dev/dri/*`, env override forced off, etc.). Decodes the
 * single keyframe in libavcodec and runs crop+scale in libavfilter on the
 * CPU. Slow on heavy 4K HEVC 10-bit content (~3 s per frame on the
 * benched box) but works everywhere.
 */
export class SwExtractor implements ExtractorBackend {
  readonly name = 'sw';

  describe(): string {
    return 'sw';
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
  }: ExtractArgs): string[] {
    const vf = crop
      ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=${thumbWidth}:-1`
      : `scale=${thumbWidth}:-1`;
    return [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      '1',
      '-noaccurate_seek',
      '-ss',
      String(seekSeconds),
      // Minimise per-process startup cost: we're spawning one ffmpeg per
      // thumbnail and don't need a full stream probe.
      '-analyzeduration',
      '0',
      '-probesize',
      '200000',
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
