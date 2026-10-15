import {
  qsvDeviceInitArgs,
  setSelectedRenderNode,
  vaapiDeviceInitArgs,
  vaapiRenderNode,
} from './hw-device';

describe('hw-device', () => {
  afterEach(() => setSelectedRenderNode(null));

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
});
