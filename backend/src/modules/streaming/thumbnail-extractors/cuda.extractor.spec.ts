import { CudaExtractor } from './cuda.extractor';
import type { ExtractArgs } from './types';

describe('CudaExtractor', () => {
  const ext = new CudaExtractor();
  const base: ExtractArgs = {
    inputPath: '/m/ep.mkv',
    seekSeconds: 120,
    outputPath: '/tmp/thumb.jpg',
    thumbWidth: 240,
  };

  function vfOf(args: string[]): string {
    return args[args.indexOf('-vf') + 1];
  }

  it('has the cuda backend name', () => {
    expect(ext.name).toBe('cuda');
  });

  it('describes itself as cuda', () => {
    expect(ext.describe()).toBe('cuda');
  });

  it('supports both the no-crop and crop cases', () => {
    expect(ext.supports(undefined)).toBe(true);
    expect(
      ext.supports({ width: 3840, height: 1632, x: 0, y: 264 }),
    ).toBe(true);
  });

  it('no-crop: scale_cuda then hwdownload to nv12', () => {
    const args = ext.buildArgs(base);
    expect(vfOf(args)).toBe(
      'scale_cuda=w=240:h=-2:format=nv12,hwdownload,format=nv12',
    );
    expect(args.slice(0, 8)).toEqual([
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      '1',
      '-hwaccel',
      'cuda',
    ]);
    expect(args).toEqual(
      expect.arrayContaining(['-hwaccel_output_format', 'cuda']),
    );
  });

  it('crop: full-frame hwdownload then CPU crop+scale', () => {
    const args = ext.buildArgs({
      ...base,
      crop: { width: 3840, height: 1632, x: 0, y: 264 },
    });
    expect(vfOf(args)).toBe('hwdownload,crop=3840:1632:0:264,scale=240:-1');
  });
});
