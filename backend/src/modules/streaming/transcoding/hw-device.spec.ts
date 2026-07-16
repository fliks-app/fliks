import {
  qsvDeviceInitArgs,
  vaapiDeviceInitArgs,
  vaapiRenderNode,
} from './hw-device';

describe('hw-device', () => {
  const original = process.env.FLIKS_VAAPI_RENDER_NODE;
  afterEach(() => {
    if (original === undefined) delete process.env.FLIKS_VAAPI_RENDER_NODE;
    else process.env.FLIKS_VAAPI_RENDER_NODE = original;
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
});
