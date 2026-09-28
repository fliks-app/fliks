import { buildImageBurnInFilterComplex } from './subtitle-overlay-filter';

describe('buildImageBurnInFilterComplex: framesOnGpu', () => {
  it('nvenc + GPU-ending chain: hwdownload before the composite', () => {
    const fc = buildImageBurnInFilterComplex({
      hwAccel: 'nvenc',
      videoFilter: 'scale_cuda=w=1920:h=-2',
      streamIndex: 3,
      width: 1920,
      height: 1080,
      bitDepth: 8,
      framesOnGpu: true,
    });
    expect(fc).toContain('hwdownload,format=nv12');
    expect(fc).toContain('hwupload_cuda[vout]');
  });

  it('nvenc + CPU-ending chain (CPU/OpenCL tone-map bounce, or CPU decode): no hwdownload', () => {
    const fc = buildImageBurnInFilterComplex({
      hwAccel: 'nvenc',
      videoFilter: 'scale=1920:1080:flags=lanczos,format=yuv420p',
      streamIndex: 3,
      width: 1920,
      height: 1080,
      bitDepth: 8,
      framesOnGpu: false,
    });
    expect(fc).not.toContain('hwdownload');
    expect(fc).not.toContain('hwupload_cuda');
    expect(fc).toContain('[ov]format=yuv420p[vout]');
  });
});
