import { applyTizenAudioCodecs, tizenSupportsHevc } from './tizen-capabilities';

function installWebapis(
  audio: Record<string, boolean> | null,
  video: Record<string, boolean> | null = null,
): void {
  (window as any).webapis = {
    systeminfo: {
      ...(audio
        ? { isSupportedAudioCodec: (c: string) => audio[c] ?? false }
        : {}),
      ...(video
        ? { isSupportedVideoCodec: (c: string) => video[c] ?? false }
        : {}),
    },
  };
}

describe('tizen-capabilities', () => {
  afterEach(() => {
    delete (window as any).webapis;
  });

  it('keeps the probed list untouched when the API is missing', () => {
    expect(applyTizenAudioCodecs(['aac', 'flac'])).toEqual(['aac', 'flac']);
    expect(tizenSupportsHevc()).toBeNull();
  });

  it('adds Dolby the MSE probe missed and keeps non-enumerated codecs', () => {
    installWebapis({ AAC: true, AC3: true, 'E-AC3': true, OPUS: false });
    expect(applyTizenAudioCodecs(['aac', 'flac'])).toEqual([
      'flac',
      'aac',
      'ac3',
      'eac3',
    ]);
  });

  it('drops a codec the TV says it cannot decode', () => {
    installWebapis({ AAC: true, AC3: false, 'E-AC3': false, OPUS: false });
    expect(applyTizenAudioCodecs(['aac', 'ac3', 'eac3'])).toEqual(['aac']);
  });

  it('survives a throwing API and keeps the probed answer', () => {
    (window as any).webapis = {
      systeminfo: {
        isSupportedAudioCodec: () => {
          throw new Error('not implemented');
        },
      },
    };
    expect(applyTizenAudioCodecs(['aac', 'eac3'])).toEqual(['aac', 'eac3']);
  });

  it('reports HEVC support from the video probe', () => {
    installWebapis(null, { HEVC: true });
    expect(tizenSupportsHevc()).toBe(true);
    installWebapis(null, { HEVC: false });
    expect(tizenSupportsHevc()).toBe(false);
  });
});
