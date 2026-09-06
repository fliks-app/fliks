import { tonemapChain } from './tonemap';
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
      '-noaccurate_seek',
      '-ss',
      String(seekSeconds),
      // `-analyzeduration 0` keeps per-thumbnail startup minimal; the 5 MB
      // probe is a ceiling read only when the demuxer needs it. AV1-in-Matroska
      // requires it so the decoder is set up for the `-ss` seek — under ~3 MB
      // the post-seek decode yields no frame and the thumbnail comes out blank.
      '-analyzeduration',
      '0',
      '-probesize',
      '5000000',
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
