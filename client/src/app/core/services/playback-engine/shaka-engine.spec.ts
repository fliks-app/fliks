import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShakaEngine } from './shaka-engine';

const player = vi.hoisted(() => ({
  attach: vi.fn(() => Promise.resolve()),
  configure: vi.fn(),
  setVideoContainer: vi.fn(),
  getNetworkingEngine: () => ({ registerResponseFilter: vi.fn() }),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  getVariantTracks: vi.fn(() => [] as unknown[]),
  destroy: vi.fn(() => Promise.resolve()),
}));

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

describe('ShakaEngine audio tracks', () => {
  beforeEach(() => vi.clearAllMocks());

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
  beforeEach(() => vi.clearAllMocks());

  it('leaves forced subtitles to the app, so an explicit Off survives every load', async () => {
    await initEngine();
    expect(player.configure).toHaveBeenCalledWith(
      expect.objectContaining({ accessibility: { handleForcedSubtitlesAutomatically: false } }),
    );
  });
});
