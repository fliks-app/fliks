import { SERVER_FEATURES, serverFeatures } from './server-features';

describe('serverFeatures', () => {
  const engine = (engineFeatures: string[]) => ({ engineFeatures });

  it('is empty without an engine', () => {
    expect(serverFeatures(undefined)).toEqual([]);
  });

  it('is what the engine announces', () => {
    expect(
      serverFeatures(engine(['decide', 'serve', 'sessions', 'events'])),
    ).toEqual([...SERVER_FEATURES]);
    expect(serverFeatures(engine(['decide']))).toEqual([
      'deviceProfileExtensions',
    ]);
    expect(serverFeatures(engine(['serve']))).toEqual([
      'hlsSubtitleRequest',
      'muxedAudioRendition',
    ]);
  });
});
