import { afterEach, vi } from 'vitest';
import { probeAudioDirectPlay, undecodableAudioFormats } from './audio-direct-play';

const opens = (...mimes: string[]) => ({ canPlayType: (m: string) => (mimes.some((x) => m.startsWith(x)) ? 'maybe' : '') });

describe('probeAudioDirectPlay', () => {
  it('lists only what the element reports', () => {
    const p = probeAudioDirectPlay(opens('audio/mpeg', 'audio/flac'));
    expect(p).toEqual({ containers: ['mp3', 'flac'], videoCodecs: [], audioCodecs: ['mp3', 'flac'] });
  });

  it('maps a MIME to the containers and codecs the server names', () => {
    const p = probeAudioDirectPlay(opens('audio/ogg', 'audio/mp4'));
    expect(p.containers).toEqual(['m4a', 'mp4', 'ogg', 'opus']);
    expect(p.audioCodecs).toEqual(['aac', 'alac', 'vorbis', 'opus']);
  });

  it('is empty for an element that opens nothing', () => {
    expect(probeAudioDirectPlay(opens())).toEqual({ containers: [], videoCodecs: [], audioCodecs: [] });
  });

  it('drops a MIME the capabilities API refused', () => {
    const p = probeAudioDirectPlay(opens('audio/mpeg', 'audio/flac'), new Set(['audio/flac']));
    expect(p.audioCodecs).toEqual(['mp3']);
  });
});

describe('undecodableAudioFormats', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('collects the MIMEs decodingInfo refuses and ignores one it throws on', async () => {
    const decodingInfo = vi.fn(async ({ audio }: { audio: { contentType: string } }) => {
      if (audio.contentType === 'audio/flac') return { supported: false };
      if (audio.contentType === 'audio/aac') throw new TypeError('unknown type');
      return { supported: true };
    });
    vi.stubGlobal('navigator', { mediaCapabilities: { decodingInfo } });
    expect([...(await undecodableAudioFormats())]).toEqual(['audio/flac']);
  });

  it('is empty where the API is missing', async () => {
    vi.stubGlobal('navigator', {});
    expect((await undecodableAudioFormats()).size).toBe(0);
  });
});
