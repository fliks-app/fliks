import { QoeLoadProvider } from './qoe-load.provider';

describe('QoeLoadProvider', () => {
  function probe(engine?: object, engineEvents?: object) {
    let read: () => { activeTranscodes: number; activeSessions: number };
    const qoe = { setLoadProbe: (p: typeof read) => (read = p) };
    const transcoding = {
      getActiveSessions: () => [
        { remux: false, throttlePaused: false },
        { remux: true },
        { remux: false, throttlePaused: true },
      ],
      isProducing: () => true,
    };
    new QoeLoadProvider(
      qoe as never,
      transcoding as never,
      { list: () => [1, 2, 3, 4] } as never,
      engine as never,
      engineEvents as never,
    ).onModuleInit();
    return () => read();
  }

  it("counts the host's own transcodes on the TS runtime", () => {
    expect(probe()()).toEqual({ activeTranscodes: 1, activeSessions: 4 });
    expect(probe({ runtime: false }, { activeJobs: 7 })()).toEqual({
      activeTranscodes: 1,
      activeSessions: 4,
    });
  });

  it('counts the jobs the engine events keep when the engine runs playback', () => {
    expect(probe({ runtime: true }, { activeJobs: 7 })()).toEqual({
      activeTranscodes: 7,
      activeSessions: 4,
    });
  });
});
