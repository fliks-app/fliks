import { applyTizenAudioCodecs, tizenDecoderLevels, tizenVideo } from './tizen-capabilities';
import type { WebVideo } from './device-capabilities/web-video';

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

  describe('tizenVideo', () => {
    const probed = (codecs: string[]): WebVideo => ({
      containers: ['mp4'],
      videoCodecs: codecs,
      codecConditions: [
        { codec: 'h264', maxLevel: 40, profiles: ['high'], maxBitDepth: 8 },
        { codec: 'hevc', maxLevel: 120, profiles: ['main'], maxBitDepth: 8 },
      ],
    });

    it('before Tizen 6.0 keeps the WebView answer for H.264 and WebM codecs, claims HEVC from the spec, never AV1', () => {
      const v = tizenVideo(probed(['h264', 'avc1', 'vp9', 'av1']));
      expect(v.videoCodecs).toEqual(['h264', 'avc1', 'hevc', 'h265', 'hvc1', 'vp9']);
      expect(v.codecConditions.map((c) => c.codec)).toEqual(['h264', 'hevc']);
    });

    it('lets the firmware decide every codec it enumerates', () => {
      installWebapis(null, { H264: true, HEVC: true, AV1: true, VP9: false, MPEG2: true });
      const v = tizenVideo(probed(['h264', 'avc1', 'vp9']));
      expect(v.videoCodecs).toEqual(['h264', 'avc1', 'hevc', 'h265', 'hvc1', 'av1', 'mpeg2video']);
      expect(v.codecConditions.find((c) => c.codec === 'av1')).toEqual({ codec: 'av1', maxBitDepth: 10, profiles: ['main'] });
    });

    it('drops HEVC when the firmware says it does not decode it', () => {
      installWebapis(null, { H264: true, HEVC: false });
      expect(tizenVideo(probed(['h264'])).videoCodecs).toEqual(['h264', 'avc1']);
    });

    it('adds the spec demuxers and the panel decoder levels', () => {
      (window as any).webapis = { productinfo: { isUdPanelSupported: () => true, is8KPanelSupported: () => false } };
      const v = tizenVideo(probed(['h264']));
      expect(v.containers).toEqual(['mp4', 'mkv', 'mov', 'ts', 'm2ts', 'avi', 'webm']);
      expect(v.codecConditions.find((c) => c.codec === 'h264')?.maxLevel).toBe(51);
      expect(v.codecConditions.find((c) => c.codec === 'hevc')?.maxLevel).toBe(153);
    });
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
