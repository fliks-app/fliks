import {
  hostHasVaapi,
  openclTonemapInitArgs,
  qsvDeviceInitArgs,
  setSelectedRenderNode,
  vaapiDeviceInitArgs,
  vaapiRenderNode,
} from './hw-device';

describe('hw-device', () => {
  const originalOpencl = process.env.FLIKS_OPENCL_DEVICE;
  afterEach(() => {
    setSelectedRenderNode(null);
    if (originalOpencl === undefined) delete process.env.FLIKS_OPENCL_DEVICE;
    else process.env.FLIKS_OPENCL_DEVICE = originalOpencl;
  });

  describe('vaapiRenderNode', () => {
    it('defaults to /dev/dri/renderD128', () => {
      expect(vaapiRenderNode()).toBe('/dev/dri/renderD128');
    });
    it('honours the admin selection', () => {
      setSelectedRenderNode('/dev/dri/renderD129');
      expect(vaapiRenderNode()).toBe('/dev/dri/renderD129');
    });
    it('treats auto and a blank selection as no pin', () => {
      setSelectedRenderNode('auto');
      expect(vaapiRenderNode()).toBe('/dev/dri/renderD128');
      setSelectedRenderNode('   ');
      expect(vaapiRenderNode()).toBe('/dev/dri/renderD128');
    });
  });

  describe('vaapiDeviceInitArgs', () => {
    it('binds VAAPI to the render node', () => {
      expect(vaapiDeviceInitArgs()).toEqual([
        '-init_hw_device',
        'vaapi=va:/dev/dri/renderD128',
      ]);
    });
  });

  describe('qsvDeviceInitArgs', () => {
    it('derives QSV from VAAPI on Linux', () => {
      expect(qsvDeviceInitArgs('linux')).toEqual([
        '-init_hw_device',
        'vaapi=va:/dev/dri/renderD128',
        '-init_hw_device',
        'qsv=qs@va',
      ]);
    });
    it('initialises QSV natively on Windows (no VAAPI, no render node)', () => {
      expect(qsvDeviceInitArgs('win32')).toEqual([
        '-init_hw_device',
        'qsv=qs',
      ]);
    });
    it('threads the pinned render node into the Linux VAAPI device', () => {
      setSelectedRenderNode('/dev/dri/renderD129');
      expect(qsvDeviceInitArgs('linux')).toEqual([
        '-init_hw_device',
        'vaapi=va:/dev/dri/renderD129',
        '-init_hw_device',
        'qsv=qs@va',
      ]);
    });
  });

  describe('hostHasVaapi', () => {
    it('is true on Linux (QSV is VAAPI-backed)', () => {
      expect(hostHasVaapi('linux')).toBe(true);
    });
    it('is false on Windows (QSV runs natively on D3D11)', () => {
      expect(hostHasVaapi('win32')).toBe(false);
    });
  });

  describe('openclTonemapInitArgs', () => {
    it('auto-picks the first usable OpenCL platform by default', () => {
      delete process.env.FLIKS_OPENCL_DEVICE;
      expect(openclTonemapInitArgs()).toEqual([
        '-init_hw_device',
        'opencl=ocl',
        '-filter_hw_device',
        'ocl',
      ]);
    });

    it('pins the platform.device from FLIKS_OPENCL_DEVICE', () => {
      process.env.FLIKS_OPENCL_DEVICE = '0.0';
      expect(openclTonemapInitArgs()).toEqual([
        '-init_hw_device',
        'opencl=ocl:0.0',
        '-filter_hw_device',
        'ocl',
      ]);
    });

    it('ignores a blank override', () => {
      process.env.FLIKS_OPENCL_DEVICE = '  ';
      expect(openclTonemapInitArgs()).toEqual([
        '-init_hw_device',
        'opencl=ocl',
        '-filter_hw_device',
        'ocl',
      ]);
    });
  });
});
