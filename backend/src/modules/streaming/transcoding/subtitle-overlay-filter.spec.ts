import { buildImageBurnInFilterComplex } from './subtitle-overlay-filter';

describe('buildImageBurnInFilterComplex', () => {
  it('names the VAAPI device on the re-upload (the default filter device can be Vulkan)', () => {
    const vf = buildImageBurnInFilterComplex({
      hwAccel: 'vaapi',
      videoFilter: 'scale_vaapi=w=1920:h=-2:format=nv12',
      streamIndex: 3,
      width: 1920,
      height: 1080,
      bitDepth: 10,
    });
    expect(vf).toContain('hwupload=derive_device=vaapi:extra_hw_frames=16');
  });
});
