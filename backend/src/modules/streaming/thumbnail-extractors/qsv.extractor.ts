import { downloadPixFmt, tonemapChain } from './tonemap';
import type { CropArea, ExtractArgs, ExtractorBackend } from './types';

/**
 * QSV backend — used for the crop case because `vpp_qsv` can crop AND
 * scale on the GPU in one filter. Without HW crop, we'd have to either
 * download the full-res decoded frame (catastrophic for 4K — collapses
 * throughput by ~200×) or compute scaled crop coordinates on a small
 * downloaded frame (needs source dimensions piped through everywhere).
 *
 * Benched on Intel Arc A370M / 1080p HEVC letterboxed: ~420 ms wall for
 * 10 frames at 4 workers. Slightly slower than {@link VaapiExtractor}
 * on the no-crop 4K path (~1700 ms vs 960 ms) because QSV's libvpl-based
 * decoder has higher per-invocation init, so we keep VAAPI for no-crop
 * and only use QSV when crop is requested.
 */
export class QsvExtractor implements ExtractorBackend {
  readonly name = 'qsv';
  constructor(private readonly device: string) {}

  describe(): string {
    return `qsv(${this.device})`;
  }

  supports(crop?: CropArea): boolean {
    return !!crop;
  }

  buildArgs({
    inputPath,
    seekSeconds,
    outputPath,
    crop,
    thumbWidth,
    hdr,
  }: ExtractArgs): string[] {
    if (!crop) {
      // supports() should have routed this elsewhere, but type-narrow safely.
      throw new Error('QsvExtractor requires a crop config');
    }
    // Output height preserves the crop region's aspect ratio. Rounded to
    // an even number — required by most video filters / encoders.
    const outH = Math.round((crop.height * thumbWidth) / crop.width / 2) * 2;
    const pix = downloadPixFmt(hdr);
    return [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      '1',
      // Native VAAPI decode, not the `-hwaccel qsv` wrapper: the wrapper
      // drops Dolby Vision RPU side data and fails outright on real AV1.
      '-init_hw_device',
      `vaapi=va:${this.device}`,
      '-init_hw_device',
      'qsv=hw@va',
      '-filter_hw_device',
      'hw',
      '-hwaccel',
      'vaapi',
      '-hwaccel_output_format',
      'vaapi',
      '-noaccurate_seek',
      '-ss',
      String(seekSeconds),
      '-an',
      '-sn',
      '-i',
      inputPath,
      '-frames:v',
      '1',
      // hwmap onto the qsv device first (the decoder emits vaapi surfaces);
      // vpp_qsv then crops with cw/ch/cx/cy and scales to w/h in one GPU pass.
      '-vf',
      `hwmap=derive_device=qsv,vpp_qsv=w=${thumbWidth}:h=${outH}:cw=${crop.width}:ch=${crop.height}:cx=${crop.x}:cy=${crop.y}:format=${pix},hwdownload,format=${pix}${hdr ? `,${tonemapChain(thumbWidth)}` : ''}`,
      '-q:v',
      '5',
      '-y',
      outputPath,
    ];
  }
}
