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
    getStats: vi.fn(),
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

describe('ShakaEngine.getQoeSample', () => {
  it('maps shaka stats, the active variant and the buffer ahead of the playhead', async () => {
    const container = document.createElement('div');
    const video = document.createElement('video');
    container.appendChild(video);
    Object.defineProperty(video, 'currentTime', { value: 10 });
    Object.defineProperty(video, 'buffered', {
      value: { length: 1, start: () => 0, end: () => 14.5 },
    });
    const engine = new ShakaEngine();
    await engine.init(video);
    player.getStats.mockReturnValue({ droppedFrames: 3, decodedFrames: 900, estimatedBandwidth: 8e6 });
    player.getVariantTracks.mockReturnValue([
      { active: false, bandwidth: 1 },
      { active: true, bandwidth: 5e6, width: 1920, height: 1080, videoCodec: 'hvc1' },
    ]);

    expect(await engine.getQoeSample()).toEqual({
      engine: 'shaka',
      cmcd: true,
      droppedFrames: 3,
      decodedFrames: 900,
      bandwidthBps: 8e6,
      bufferAheadS: 4.5,
      variantBitrate: 5e6,
      width: 1920,
      height: 1080,
      videoCodec: 'hvc1',
      decoderName: null,
      hwDecoder: null,
    });
  });

  it('enables CMCD in query mode', async () => {
    await initEngine();
    expect(player.configure).toHaveBeenCalledWith(
      expect.objectContaining({ cmcd: { enabled: true, useHeaders: false } }),
    );
  });
});

describe('ShakaEngine.getQoeSample unknowns', () => {
  it('reports null rather than 0 for nothing buffered and an unknown bitrate', async () => {
    const container = document.createElement('div');
    const video = document.createElement('video');
    container.appendChild(video);
    const engine = new ShakaEngine();
    await engine.init(video);
    player.getStats.mockReturnValue({});
    player.getVariantTracks.mockReturnValue([{ active: true, bandwidth: 0 }]);
    expect(await engine.getQoeSample()).toMatchObject({ bufferAheadS: null, variantBitrate: null });
  });
});

describe('ShakaEngine buffering bridge', () => {
  async function setup(paused: boolean) {
    const container = document.createElement('div');
    const video = document.createElement('video');
    container.appendChild(video);
    Object.defineProperty(video, 'paused', { value: paused });
    const engine = new ShakaEngine();
    await engine.init(video);
    const states: string[] = [];
    engine.on('stateChanged', (e) => states.push(e.state));
    const fire = (buffering: boolean) =>
      player.addEventListener.mock.calls.find((c) => c[0] === 'buffering')![1]({ buffering });
    return { video, states, fire };
  }

  it("maps shaka's own buffering event, once per episode", async () => {
    const { video, states, fire } = await setup(false);
    fire(true);
    video.dispatchEvent(new Event('waiting'));
    fire(true);
    expect(states).toEqual(['buffering']);
    fire(false);
    expect(states).toEqual(['buffering', 'playing']);
  });

  it('does not report buffering while paused and resumes to paused', async () => {
    const { states, fire } = await setup(true);
    fire(true);
    fire(false);
    expect(states).toEqual(['paused']);
  });

  it('re-asserts buffering when canplay fires inside an open shaka episode', async () => {
    const { video, states, fire } = await setup(false);
    fire(true);
    video.dispatchEvent(new Event('canplay'));
    video.dispatchEvent(new Event('playing'));
    video.dispatchEvent(new Event('waiting'));
    expect(states).toEqual(['buffering']);
    fire(false);
    video.dispatchEvent(new Event('waiting'));
    expect(states).toEqual(['buffering', 'playing', 'buffering']);
  });

  it('a play after a pause inside an open shaka episode reports playing, then buffering', async () => {
    const { video, states, fire } = await setup(false);
    fire(true);
    video.dispatchEvent(new Event('pause'));
    video.dispatchEvent(new Event('play'));
    expect(states).toEqual(['buffering', 'paused', 'playing', 'buffering']);
  });
});
