import type { CropArea, ExtractArgs, ExtractorBackend } from './types';

/** CUDA/NVDEC backend for NVIDIA Linux hosts. `scale_cuda` converts p010→nv12
 *  itself (untonemapped, like vaapi/qsv) but has no crop option, so the crop
 *  case falls back to a CPU crop+scale. */
export class CudaExtractor implements ExtractorBackend {
  readonly name = 'cuda';

  describe(): string {
    return 'cuda';
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
      ? // ponytail: full-frame download on crop; cuvid -crop/-resize if benches say so
        `hwdownload,crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=${thumbWidth}:-1`
      : `scale_cuda=w=${thumbWidth}:h=-2:format=nv12,hwdownload,format=nv12`;
    return [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      '1',
      '-hwaccel',
      'cuda',
      '-hwaccel_output_format',
      'cuda',
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
