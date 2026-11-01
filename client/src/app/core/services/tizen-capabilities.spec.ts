import { applyTizenAudioCodecs, tizenDecoderLevels, tizenSupportsVideoCodec } from './tizen-capabilities';

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
    expect(applyTizenAudioCodecs(['aac', 'mp3'])).toEqual(['aac', 'mp3']);
    expect(tizenSupportsVideoCodec('HEVC')).toBeNull();
    expect(tizenDecoderLevels()).toBeNull();
  });

  it('adds Dolby the MSE probe missed and keeps non-enumerated codecs', () => {
    installWebapis({ AAC: true, AC3: true, 'E-AC3': true, OPUS: false });
    expect(applyTizenAudioCodecs(['aac', 'mp3'])).toEqual([
      'mp3',
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

  it('drops FLAC and ALAC, which AVPlay does not decode in a container', () => {
    expect(applyTizenAudioCodecs(['aac', 'flac', 'alac'])).toEqual(['aac']);
  });

  it('reports video support from the video probe', () => {
    installWebapis(null, { HEVC: true, AV1: false });
    expect(tizenSupportsVideoCodec('HEVC')).toBe(true);
    expect(tizenSupportsVideoCodec('AV1')).toBe(false);
  });

  it('maps the panel class to the spec decoder levels', () => {
    const panel = (ud: boolean, k8: boolean) => {
      (window as any).webapis = {
        productinfo: { isUdPanelSupported: () => ud, is8KPanelSupported: () => k8 },
      };
      return tizenDecoderLevels();
    };
    expect(panel(false, false)).toEqual({ h264: 42, hevc: 123 });
    expect(panel(true, false)).toEqual({ h264: 51, hevc: 153 });
    expect(panel(true, true)).toEqual({ h264: 51, hevc: 183 });
  });
});
