import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShakaEngine } from './shaka-engine';

const player = vi.hoisted(() => {
  const defaults = {
    attach: () => Promise.resolve(),
    getVariantTracks: () => [] as unknown[],
    getTextTracks: () => [] as unknown[],
    load: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  const p = {
    attach: vi.fn(),
    configure: vi.fn(),
    setVideoContainer: vi.fn(),
    getNetworkingEngine: () => ({ registerResponseFilter: vi.fn() }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getVariantTracks: vi.fn(),
    getTextTracks: vi.fn(),
    addTextTrackAsync: vi.fn(),
    load: vi.fn(),
    destroy: vi.fn(),
  };
  /** Drops calls, queued `Once` values and per-test overrides, then reinstalls the defaults. */
  const reset = () => {
    for (const fn of Object.values(p)) if (vi.isMockFunction(fn)) fn.mockReset();
    for (const [k, impl] of Object.entries(defaults)) (p as any)[k].mockImplementation(impl);
  };
  return Object.assign(p, { reset });
});

vi.mock('shaka-player', () => ({
  default: {
    polyfill: { installAll: () => {} },
    Player: class {
      static isBrowserSupported = () => true;
      constructor() {
        return player;
      }
    },
    text: { UITextDisplayer: class {} },
    net: { NetworkingEngine: { RequestType: { MANIFEST: 0, SEGMENT: 1 } } },
    util: { Error: class {} },
  },
}));

async function initEngine(): Promise<ShakaEngine> {
  const container = document.createElement('div');
  const video = document.createElement('video');
  container.appendChild(video);
  const engine = new ShakaEngine();
  await engine.init(video);
  return engine;
}

beforeEach(() => player.reset());

describe('ShakaEngine audio tracks', () => {
  it('lists one track per audio rendition and flags the one the active variant plays', async () => {
    const engine = await initEngine();
    player.getVariantTracks.mockReturnValue([
      { audioId: 4, videoId: 0, language: 'en', audioCodec: 'aac', active: false },
      { audioId: 7, videoId: 0, language: 'fr', audioCodec: 'aac', active: true },
      { audioId: 4, videoId: 1, language: 'en', audioCodec: 'aac', active: false },
      { audioId: 7, videoId: 1, language: 'fr', audioCodec: 'aac', active: false },
    ]);

    expect(engine.getAudioTracks().map((t) => [t.id, t.selected])).toEqual([
      ['shaka-4', false],
      ['shaka-7', true],
    ]);
  });
});

describe('ShakaEngine subtitle authority', () => {
  it('leaves forced subtitles to the app, so an explicit Off survives every load', async () => {
    await initEngine();
    expect(player.configure).toHaveBeenCalledWith(
      expect.objectContaining({ accessibility: { handleForcedSubtitlesAutomatically: false } }),
    );
  });
});

describe('ShakaEngine.addTextTrack', () => {
  const rendition = (id: number, language: string, forced = false) => ({ id, language, forced });

  it('matches the HLS rendition of the picked language, forced-ness and ordinal', async () => {
    const engine = await initEngine();
    const tracks = [rendition(1, 'en'), rendition(2, 'fr'), rendition(3, 'fr'), rendition(4, 'fr', true)];
    player.getTextTracks.mockReturnValue(tracks);

    expect(await engine.addTextTrack('u', 'fre', 'Français', false, 1)).toBe(tracks[2]);
    expect(await engine.addTextTrack('u', 'fre', 'Français', true, 0)).toBe(tracks[3]);
    expect(player.addTextTrackAsync).not.toHaveBeenCalled();
  });

  it('sideloads the WebVTT when the stream carries no rendition (DirectPlay)', async () => {
    const engine = await initEngine();
    const added = { id: 9, language: 'fr', forced: false };
    player.addTextTrackAsync.mockResolvedValue(added);

    expect(await engine.addTextTrack('https://x/subtitles/5', 'fr', 'Français', false)).toBe(added);
    expect(player.addTextTrackAsync).toHaveBeenCalledWith(
      'https://x/subtitles/5', 'fr', 'subtitles', 'text/vtt', undefined, 'Français', false,
    );
  });

  it('sideloads once per URL, and never matches a sideloaded track as a rendition', async () => {
    const engine = await initEngine();
    const first = { id: 9, language: 'fr', forced: false };
    const second = { id: 10, language: 'fr', forced: false };
    player.addTextTrackAsync.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    expect(await engine.addTextTrack('u1', 'fr', 'A')).toBe(first);
    player.getTextTracks.mockReturnValue([first]);
    expect(await engine.addTextTrack('u1', 'fr', 'A')).toBe(first);
    expect(await engine.addTextTrack('u2', 'fr', 'B', false, 1)).toBe(second);
    expect(player.addTextTrackAsync).toHaveBeenCalledTimes(2);
  });

  it('forgets the sideloaded tracks with the manifest', async () => {
    const engine = await initEngine();
    player.addTextTrackAsync.mockResolvedValue({ id: 9, language: 'fr' });
    await engine.addTextTrack('u1', 'fr', 'A');
    await engine.load('https://x/video.mp4');
    await engine.addTextTrack('u1', 'fr', 'A');
    expect(player.addTextTrackAsync).toHaveBeenCalledTimes(2);
  });

  it('rejects rather than show another language', async () => {
    const engine = await initEngine();
    player.getTextTracks.mockReturnValue([rendition(1, 'en')]);
    await expect(engine.addTextTrack('', 'fr', 'Français')).rejects.toThrow();
    expect(player.addTextTrackAsync).not.toHaveBeenCalled();
  });
});
