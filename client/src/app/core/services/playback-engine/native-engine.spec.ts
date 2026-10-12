import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeEngine } from './native-engine';

const plugin = vi.hoisted(() => ({
  create: vi.fn(() => Promise.resolve()),
  getSubtitleTracks: vi.fn(() => Promise.resolve({ tracks: [] })),
  load: vi.fn((_options: unknown) => Promise.resolve()),
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

describe('NativeEngine sidecar subtitles', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the sidecars set for the load, forced flag included', async () => {
    const engine = new NativeEngine();
    const sidecars = [
      { url: 'https://x/subtitles/1', language: 'en', label: 'English', forced: false },
      { url: 'https://x/subtitles/2', language: 'en', label: 'English forced', forced: true },
    ];
    engine.setPreloadedSubtitles(sidecars);
    await engine.load('https://x/video.mkv');
    expect(plugin.load).toHaveBeenCalledWith(expect.objectContaining({ subtitles: sidecars }));
  });

  it('sends the list the player set last, so a later load can drop them', async () => {
    const engine = new NativeEngine();
    engine.setPreloadedSubtitles([{ url: 'https://x/subtitles/1', language: 'en', label: 'English' }]);
    await engine.load('https://x/video.mkv');
    engine.setPreloadedSubtitles([]);
    await engine.load('https://x/master.m3u8');
    expect(plugin.load).toHaveBeenLastCalledWith(expect.objectContaining({ subtitles: [] }));
  });
});

describe('NativeEngine audio tracks across loads', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forgets the previous item\'s tracks when the next one loads', async () => {
    const engine = new NativeEngine();
    await engine.init(document.createElement('div'));
    window.dispatchEvent(
      new CustomEvent('nativePlayerTracksChanged', {
        detail: { audioTracks: [{ id: 'audio-0', language: 'en', label: 'English' }], subtitleTracks: [] },
      }),
    );
    expect(engine.getAudioTracks()).toHaveLength(1);

    await engine.load('https://x/master.m3u8');

    expect(engine.getAudioTracks()).toEqual([]);
    await engine.destroy();
  });
});
