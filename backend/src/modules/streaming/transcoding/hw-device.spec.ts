import {
  openclTonemapInitArgs,
  qsvDeviceInitArgs,
  vaapiDeviceInitArgs,
  vaapiRenderNode,
} from './hw-device';

describe('hw-device', () => {
  const original = process.env.FLIKS_VAAPI_RENDER_NODE;
  const originalOpencl = process.env.FLIKS_OPENCL_DEVICE;
  afterEach(() => {
    if (original === undefined) delete process.env.FLIKS_VAAPI_RENDER_NODE;
    else process.env.FLIKS_VAAPI_RENDER_NODE = original;
    if (originalOpencl === undefined) delete process.env.FLIKS_OPENCL_DEVICE;
    else process.env.FLIKS_OPENCL_DEVICE = originalOpencl;
  });

  describe('vaapiRenderNode', () => {
    it('defaults to /dev/dri/renderD128', () => {
      delete process.env.FLIKS_VAAPI_RENDER_NODE;
      expect(vaapiRenderNode()).toBe('/dev/dri/renderD128');
    });
    it('honours the FLIKS_VAAPI_RENDER_NODE override', () => {
      process.env.FLIKS_VAAPI_RENDER_NODE = '/dev/dri/renderD129';
      expect(vaapiRenderNode()).toBe('/dev/dri/renderD129');
    });
    it('ignores a blank override', () => {
      process.env.FLIKS_VAAPI_RENDER_NODE = '   ';
      expect(vaapiRenderNode()).toBe('/dev/dri/renderD128');
    });
  });

  describe('vaapiDeviceInitArgs', () => {
    it('binds VAAPI to the render node', () => {
      delete process.env.FLIKS_VAAPI_RENDER_NODE;
      expect(vaapiDeviceInitArgs()).toEqual([
        '-init_hw_device',
        'vaapi=va:/dev/dri/renderD128',
      ]);
    });
  });

  describe('qsvDeviceInitArgs', () => {
    it('derives QSV from VAAPI on Linux', () => {
      delete process.env.FLIKS_VAAPI_RENDER_NODE;
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
    it('threads the render-node override into the Linux VAAPI device', () => {
      process.env.FLIKS_VAAPI_RENDER_NODE = '/dev/dri/renderD129';
      expect(qsvDeviceInitArgs('linux')).toEqual([
        '-init_hw_device',
        'vaapi=va:/dev/dri/renderD129',
        '-init_hw_device',
        'qsv=qs@va',
      ]);
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
