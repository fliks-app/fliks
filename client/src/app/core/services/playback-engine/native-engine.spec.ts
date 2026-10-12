import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeEngine } from './native-engine';

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

describe('NativeEngine subtitle resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    plugin.getSubtitleTracks.mockResolvedValue({ tracks: [] });
  });

  const track = (id: string, language: string, extra: Record<string, unknown> = {}) => ({
    id, language, label: id, ...extra,
  });
  const pick = async (engine: NativeEngine, language: string, extra: Record<string, unknown> = {}) => {
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

describe('NativeEngine.getQoeSample', () => {
  it('returns the plugin sample', async () => {
    expect(await new NativeEngine().getQoeSample()).toEqual({ engine: 'exoplayer' });
  });

  it('returns null when the plugin lacks getQoe', async () => {
    plugin.getQoe.mockRejectedValueOnce(new Error('not implemented'));
    expect(await new NativeEngine().getQoeSample()).toBeNull();
  });
});
