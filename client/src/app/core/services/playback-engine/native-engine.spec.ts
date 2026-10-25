import type { NativeEngine as NativeEngineType } from './native-engine';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const plugin = vi.hoisted(() => ({
  create: vi.fn(() => Promise.resolve()),
  getSubtitleTracks: vi.fn(() => Promise.resolve({ tracks: [] as unknown[] })),
  selectSubtitleTrack: vi.fn((_options: unknown) => Promise.resolve()),
  load: vi.fn((_options: unknown) => Promise.resolve()),
  setCrop: vi.fn(() => Promise.resolve()),
  setFillScreen: vi.fn(() => Promise.resolve()),
  setSubtitleStyle: vi.fn(() => Promise.resolve()),
  destroy: vi.fn(() => Promise.resolve()),
  getQoe: vi.fn(() => Promise.resolve({ engine: 'exoplayer' })),
  resize: vi.fn((_options: unknown) => Promise.resolve()),
  configure: vi.fn((_options: unknown) => Promise.resolve()),
  setMaxResolution: vi.fn((_options: unknown) => Promise.resolve()),
}));

// jsdom ships no ResizeObserver; init() observes the player container.
let onResize = () => {};
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  constructor(cb: () => void) {
    onResize = cb;
  }
  observe() {}
  disconnect() {}
};

// Loaded after the mock: other specs mock @capacitor/core differently and share the plugin module.
let NativeEngine: typeof import('./native-engine').NativeEngine;
beforeAll(async () => {
  vi.resetModules();
  vi.doMock('@capacitor/core', () => ({
    registerPlugin: () => plugin,
    Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
  }));
  ({ NativeEngine } = await import('./native-engine'));
});

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

describe('NativeEngine subtitle resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    plugin.getSubtitleTracks.mockResolvedValue({ tracks: [] });
  });

  const track = (id: string, language: string, extra: Record<string, unknown> = {}) => ({
    id, language, label: id, ...extra,
  });
  const pick = async (engine: NativeEngineType, language: string, extra: Record<string, unknown> = {}) => {
    engine.selectTextTrack({ language, ...extra });
    await vi.waitFor(() => expect(plugin.getSubtitleTracks).toHaveBeenCalled());
    await Promise.resolve();
  };

  it('selects the track of the picked language', async () => {
    plugin.getSubtitleTracks.mockResolvedValue({ tracks: [track('text-0', 'en'), track('text-1', 'fr')] });
    const engine = new NativeEngine();
    await pick(engine, 'fra');
    expect(plugin.selectSubtitleTrack).toHaveBeenCalledWith({ id: 'text-1' });
  });

  it('never lands on a lone track of another language', async () => {
    plugin.getSubtitleTracks.mockResolvedValue({ tracks: [track('text-0', 'en')] });
    const engine = new NativeEngine();
    await pick(engine, 'fra');
    expect(plugin.selectSubtitleTrack).not.toHaveBeenCalled();
  });

  it('turns the previous track off when the new pick has no track in its language', async () => {
    plugin.getSubtitleTracks.mockResolvedValue({ tracks: [track('text-0', 'en')] });
    const engine = new NativeEngine();
    await pick(engine, 'eng');
    expect(plugin.selectSubtitleTrack).toHaveBeenLastCalledWith({ id: 'text-0' });
    engine.selectTextTrack({ language: 'fra' });
    expect(plugin.selectSubtitleTrack).toHaveBeenLastCalledWith({ id: null });
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

describe('NativeEngine paused flag', () => {
  it('stays playing when the player drops to idle after a failed load', async () => {
    const engine = new NativeEngine();
    await engine.init(document.createElement('div'));
    const state = (s: string) =>
      window.dispatchEvent(new CustomEvent('nativePlayerStateChanged', { detail: { state: s } }));
    state('playing');
    state('idle');
    expect(engine.paused).toBe(false);
    state('paused');
    expect(engine.paused).toBe(true);
    await engine.destroy();
  });
});

describe('NativeEngine.getQoeSample', () => {
  it('returns the plugin sample', async () => {
    expect(await new NativeEngine().getQoeSample()).toEqual({ engine: 'exoplayer' });
  });

  it('returns null when the plugin lacks getQoe', async () => {
    plugin.getQoe.mockRejectedValueOnce(new Error('not implemented'));
    expect(await new NativeEngine().getQoeSample()).toBeNull();
  });
});

describe('NativeEngine position cadence', () => {
  it('declares the 1 s refresh of ExoPlayer and AVPlayer so the freeze watch waits for it', () => {
    expect(new NativeEngine().positionUpdateMs).toBe(1_000);
  });
});

describe('NativeEngine surface placement', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the native surface on the container rectangle', async () => {
    let box = { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight };
    const container = document.createElement('div');
    container.getBoundingClientRect = () => box as DOMRect;
    const engine = new NativeEngine();
    await engine.init(container);
    expect(plugin.resize).not.toHaveBeenCalled();

    box = { ...box, right: innerWidth * 0.6, width: innerWidth * 0.6 };
    onResize();
    expect(plugin.resize).toHaveBeenLastCalledWith({ x: 0, y: 0, width: Math.round(innerWidth * 0.6), height: innerHeight });

    box = { ...box, right: innerWidth, width: innerWidth };
    onResize();
    expect(plugin.resize).toHaveBeenLastCalledWith({ x: 0, y: 0, width: -1, height: -1 });
    expect(plugin.resize).toHaveBeenCalledTimes(2);
    await engine.destroy();
  });
});

describe('NativeEngine.configure', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards the preferred audio language, an empty one included', () => {
    const engine = new NativeEngine();
    engine.configure({ preferredAudioLanguage: 'fr' });
    engine.configure({ preferredAudioLanguage: '' });
    expect(plugin.configure).toHaveBeenNthCalledWith(1, { preferredAudioLanguage: 'fr', defaultBandwidthEstimate: undefined });
    expect(plugin.configure).toHaveBeenNthCalledWith(2, { preferredAudioLanguage: '', defaultBandwidthEstimate: undefined });
  });

  it('forwards the starting bandwidth and lifts the resolution cap in auto', () => {
    new NativeEngine().configure({ abr: { enabled: true, defaultBandwidthEstimate: 100_000_000 } });
    expect(plugin.configure).toHaveBeenCalledWith({ preferredAudioLanguage: undefined, defaultBandwidthEstimate: 100_000_000 });
    expect(plugin.setMaxResolution).toHaveBeenCalledWith({ width: 0, height: 0 });
  });

  it('sends nothing native for ABR off', () => {
    new NativeEngine().configure({ abr: { enabled: false } });
    expect(plugin.configure).not.toHaveBeenCalled();
    expect(plugin.setMaxResolution).not.toHaveBeenCalled();
  });

  it('tolerates a build without the method', async () => {
    plugin.configure.mockRejectedValueOnce(new Error('not implemented'));
    expect(() => new NativeEngine().configure({ preferredAudioLanguage: 'fr' })).not.toThrow();
    await Promise.resolve();
  });
});
