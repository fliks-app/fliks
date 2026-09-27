import { deliveredKindFromVariant, resolveDownloadUrl } from './player.utils';
import type { PlaybackInfoResponse } from '../services/api/streaming-api.service';

describe('deliveredKindFromVariant', () => {
  it('is direct for a non-HLS raw stream URL', () => {
    expect(deliveredKindFromVariant('/api/stream/123?token=x&sid=y')).toBe('direct');
  });

  it('is remux for a Shaka active variant whose id carries /remux/', () => {
    expect(
      deliveredKindFromVariant(
        '/api/stream/123/master.m3u8?token=x&remux=1',
        '/api/stream/123/remux/index.m3u8?token=x',
      ),
    ).toBe('remux');
  });

  it('is transcode for a Shaka active variant on a rung, even alongside remux=1', () => {
    expect(
      deliveredKindFromVariant(
        '/api/stream/123/master.m3u8?token=x&remux=1&startQuality=original',
        '/api/stream/123/1080p/index.m3u8?token=x',
      ),
    ).toBe('transcode');
  });

  it('falls back to the query string when no variant id is available (native/Tizen/webOS/desktop)', () => {
    expect(
      deliveredKindFromVariant('/api/stream/123/master.m3u8?token=x&remux=1'),
    ).toBe('remux');
  });

  it('treats remux=1 + startQuality as a collapsed transcode rung (the trap)', () => {
    expect(
      deliveredKindFromVariant(
        '/api/stream/123/master.m3u8?token=x&remux=1&startQuality=original',
      ),
    ).toBe('transcode');
  });

  it('is transcode for a plain ladder URL with no remux flag', () => {
    expect(
      deliveredKindFromVariant('/api/stream/123/master.m3u8?token=x&startQuality=720p'),
    ).toBe('transcode');
  });
});

describe('resolveDownloadUrl', () => {
  function pi(
    playMethod: PlaybackInfoResponse['playMethod'],
    audioTracks: PlaybackInfoResponse['audioTracks'] = [],
  ): Pick<PlaybackInfoResponse, 'playMethod' | 'playUrl' | 'sessionId' | 'audioTracks'> {
    return { playMethod, playUrl: '/api/stream/123/master.m3u8?token=x', sessionId: 'sid-1', audioTracks };
  }

  it('original + DirectStream with several audio tracks: keeps the ladder so every language is stored', () => {
    const buildPlayUrl = vi.fn();
    const getHlsUrl = vi.fn().mockReturnValue('/api/stream/123/master.m3u8?token=x&startQuality=original');
    const tracks = [{}, {}] as unknown as PlaybackInfoResponse['audioTracks'];
    resolveDownloadUrl({ buildPlayUrl, getHlsUrl } as any, 123, 'original', pi('DirectStream', tracks));
    expect(buildPlayUrl).not.toHaveBeenCalled();
    expect(getHlsUrl).toHaveBeenCalledWith(123, 'original', undefined, 'sid-1');
  });

  it('original + DirectStream: builds via buildPlayUrl, no startQuality pin', () => {
    const buildPlayUrl = vi.fn().mockReturnValue('/api/stream/123/master.m3u8?token=x&remux=1&sid=sid-1');
    const getHlsUrl = vi.fn();
    const url = resolveDownloadUrl({ buildPlayUrl, getHlsUrl } as any, 123, 'original', pi('DirectStream'));
    expect(buildPlayUrl).toHaveBeenCalledWith(pi('DirectStream'), { sid: 'sid-1' });
    expect(getHlsUrl).not.toHaveBeenCalled();
    expect(url).not.toContain('startQuality');
  });

  it('lower rung: builds via getHlsUrl pinned to the requested quality', () => {
    const buildPlayUrl = vi.fn();
    const getHlsUrl = vi
      .fn()
      .mockReturnValue('/api/stream/123/master.m3u8?token=x&startQuality=720p&sid=sid-1');
    const url = resolveDownloadUrl({ buildPlayUrl, getHlsUrl } as any, 123, '720p', pi('Transcode'));
    expect(getHlsUrl).toHaveBeenCalledWith(123, '720p', undefined, 'sid-1');
    expect(buildPlayUrl).not.toHaveBeenCalled();
    expect(url).toContain('startQuality=720p');
  });

  it('original + DirectPlay: keeps the existing HLS-bundle pipeline (native downloaders need an HLS asset)', () => {
    const buildPlayUrl = vi.fn();
    const getHlsUrl = vi
      .fn()
      .mockReturnValue('/api/stream/123/master.m3u8?token=x&startQuality=original&sid=sid-1');
    resolveDownloadUrl({ buildPlayUrl, getHlsUrl } as any, 123, 'original', pi('DirectPlay'));
    expect(getHlsUrl).toHaveBeenCalledWith(123, 'original', undefined, 'sid-1');
    expect(buildPlayUrl).not.toHaveBeenCalled();
  });
});
