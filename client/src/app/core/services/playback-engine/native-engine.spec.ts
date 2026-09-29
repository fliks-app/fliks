import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeEngine } from './native-engine';

const plugin = vi.hoisted(() => ({
  load: vi.fn(() => Promise.resolve()),
  setCrop: vi.fn(() => Promise.resolve()),
  setFillScreen: vi.fn(() => Promise.resolve()),
  setSubtitleStyle: vi.fn(() => Promise.resolve()),
  destroy: vi.fn(() => Promise.resolve()),
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => plugin,
  Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
}));

const rect = { x: 0, y: 138, width: 1920, height: 804 };

describe('NativeEngine.setCrop', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards the rectangle with the source size when supported', () => {
    const engine = new NativeEngine();
    engine.cropSupported = true;
    expect(engine.setCrop(rect, 1920, 1080)).toBe(true);
    expect(plugin.setCrop).toHaveBeenCalledWith({ ...rect, sourceWidth: 1920, sourceHeight: 1080 });
  });

  it('clears the native crop when there is no rectangle', () => {
    const engine = new NativeEngine();
    engine.cropSupported = true;
    expect(engine.setCrop(undefined, 1920, 1080)).toBe(false);
    expect(plugin.setCrop).toHaveBeenCalledWith({});
  });

  it('never calls the plugin when the build lacks the capability', () => {
    const engine = new NativeEngine();
    expect(engine.setCrop(rect, 1920, 1080)).toBe(false);
    expect(plugin.setCrop).not.toHaveBeenCalled();
  });

  it('re-applies the crop after load', async () => {
    const engine = new NativeEngine();
    engine.cropSupported = true;
    engine.setCrop(rect, 1920, 1080);
    plugin.setCrop.mockClear();
    await engine.load('https://x/master.m3u8');
    expect(plugin.setCrop).toHaveBeenCalledWith({ ...rect, sourceWidth: 1920, sourceHeight: 1080 });
  });

  it('forgets the crop on destroy', async () => {
    const engine = new NativeEngine();
    engine.cropSupported = true;
    engine.setCrop(rect, 1920, 1080);
    await engine.destroy();
    plugin.setCrop.mockClear();
    await engine.load('https://x/master.m3u8');
    expect(plugin.setCrop).not.toHaveBeenCalled();
  });
});
