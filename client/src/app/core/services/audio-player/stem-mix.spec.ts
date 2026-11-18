import { DRIFT_TOLERANCE_S, GUIDE_VOCAL_LEVEL, StemMix, mixGains, needsReseek } from './stem-mix';

describe('stem-mix', () => {
  it('plays the main element until the stems are loaded', () => {
    expect(mixGains('instrumental', 0, false)).toEqual({ main: 1, instrumental: 0, vocals: 0 });
    expect(mixGains('original', 1, true)).toEqual({ main: 1, instrumental: 0, vocals: 0 });
  });

  it('mutes the main element and mixes the vocals by level', () => {
    expect(mixGains('instrumental', 0, true)).toEqual({ main: 0, instrumental: 1, vocals: 0 });
    expect(mixGains('guide', GUIDE_VOCAL_LEVEL, true).vocals).toBe(GUIDE_VOCAL_LEVEL);
    expect(mixGains('guide', 3, true).vocals).toBe(1);
  });

  it('reseeks only past the drift tolerance', () => {
    expect(needsReseek(10, 10 + DRIFT_TOLERANCE_S - 0.01)).toBe(false);
    expect(needsReseek(10, 10 - DRIFT_TOLERANCE_S - 0.01)).toBe(true);
  });

  describe('buffered mode', () => {
    const flush = () => new Promise((r) => setTimeout(r));
    let now: number;
    let sources: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; playbackRate: { value: number } }[];
    let fetchMock: ReturnType<typeof vi.fn>;
    let onReady: ReturnType<typeof vi.fn<() => void>>;
    let mix: StemMix;

    const main = (over: Partial<HTMLAudioElement> = {}) =>
      ({ paused: false, readyState: HTMLMediaElement.HAVE_FUTURE_DATA, currentTime: 10, playbackRate: 1, ...over }) as HTMLAudioElement;

    beforeEach(() => {
      now = 0;
      sources = [];
      const ctx = {
        get currentTime() {
          return now;
        },
        destination: {},
        createGain: () => ({ gain: { value: 0 }, connect: vi.fn() }),
        createBufferSource: () => {
          const s = { buffer: null, start: vi.fn(), stop: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), playbackRate: { value: 1 } };
          sources.push(s);
          return s;
        },
        decodeAudioData: vi.fn(async () => ({}) as AudioBuffer),
      };
      fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }));
      vi.stubGlobal('fetch', fetchMock);
      onReady = vi.fn<() => void>();
      mix = new StemMix(() => ctx as unknown as AudioContext, (id, kind) => `/${id}/${kind}`, onReady, () => undefined, true);
    });
    let frames: FrameRequestCallback[];
    const runFrames = () => {
      for (let i = 0; i < 5 && frames.length; i++) frames.splice(0).forEach((f) => f(0));
    };
    beforeEach(() => {
      frames = [];
      vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f));
    });
    afterEach(() => vi.unstubAllGlobals());

    it('does not fetch until a stem mode asks for the decode', async () => {
      expect(mix.load(7)).toBe(true);
      await flush();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mix.loaded).toBe(false);
    });

    it('decodes both stems on demand and reports loaded', async () => {
      mix.load(7);
      mix.decode();
      mix.decode();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mix.loaded).toBe(false);
      await flush();
      expect(mix.loaded).toBe(true);
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('starts the sources at the main position, restarts past the drift and stops on pause', async () => {
      mix.load(7);
      mix.decode();
      await flush();
      const m = main();
      mix.sync(m);
      runFrames();
      expect(sources).toHaveLength(0);
      m.currentTime = 10.2;
      runFrames();
      expect(sources.map((s) => s.start.mock.calls[0])).toEqual([[0, 10.2], [0, 10.2]]);
      now = 1;
      mix.sync(main({ currentTime: 11.2 }));
      mix.sync(main({ currentTime: 11.5 }));
      expect(sources).toHaveLength(2);
      const jumped = main({ currentTime: 20 });
      mix.sync(jumped);
      expect(sources[0].stop).toHaveBeenCalled();
      jumped.currentTime = 20.2;
      runFrames();
      expect(sources).toHaveLength(4);
      expect(sources[2].start).toHaveBeenCalledWith(0, 20.2);
      mix.sync(main({ paused: true }));
      expect(sources[2].stop).toHaveBeenCalled();
      expect(sources[3].stop).toHaveBeenCalled();
    });

    it('starts again after a pause cancelled a waiting start', async () => {
      mix.load(7);
      mix.decode();
      await flush();
      mix.sync(main());
      mix.sync(main({ paused: true }));
      const m = main();
      mix.sync(m);
      m.currentTime = 10.2;
      runFrames();
      expect(sources).toHaveLength(2);
    });

    it('discards a decode that finishes after clear', async () => {
      mix.load(7);
      mix.decode();
      mix.clear();
      await flush();
      expect(mix.loaded).toBe(false);
      expect(onReady).not.toHaveBeenCalled();
    });
  });
});
