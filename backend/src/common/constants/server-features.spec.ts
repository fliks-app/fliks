import { SERVER_FEATURES, serverFeatures } from './server-features';

describe('serverFeatures', () => {
  const engine = (runtime: boolean, engineFeatures: string[]) => ({
    runtime,
    engineFeatures,
  });

  it('is the static list on the TS runtime', () => {
    expect(serverFeatures(undefined)).toBe(SERVER_FEATURES);
    expect(serverFeatures(engine(false, []))).toBe(SERVER_FEATURES);
  });

  it('is what the engine announces when it runs playback', () => {
    expect(
      serverFeatures(engine(true, ['decide', 'serve', 'sessions', 'events'])),
    ).toEqual([...SERVER_FEATURES]);
    expect(serverFeatures(engine(true, ['decide']))).toEqual([
      'deviceProfileExtensions',
    ]);
    expect(serverFeatures(engine(true, ['serve']))).toEqual([
      'hlsSubtitleRequest',
      'muxedAudioRendition',
    ]);
  });
});
