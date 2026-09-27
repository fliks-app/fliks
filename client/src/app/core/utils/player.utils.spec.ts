import { computeVideoCropStyle, deliveredKindFromVariant, resolveDownloadUrl } from './player.utils';
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

  it('original + DirectStream with several audio tracks: the remux carries every track too', () => {
    const buildPlayUrl = vi.fn().mockReturnValue('/api/stream/123/master.m3u8?token=x&remux=1&sid=sid-1');
    const getHlsUrl = vi.fn();
    const tracks = [{}, {}] as unknown as PlaybackInfoResponse['audioTracks'];
    resolveDownloadUrl({ buildPlayUrl, getHlsUrl } as any, 123, 'original', pi('DirectStream', tracks));
    expect(getHlsUrl).not.toHaveBeenCalled();
    expect(buildPlayUrl).toHaveBeenCalledWith(pi('DirectStream', tracks), { sid: 'sid-1' });
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

describe('computeVideoCropStyle', () => {
  it('contain: crop AR matches container AR — no pillarbox around the crop', () => {
    const style = computeVideoCropStyle({
      sourceWidth: 1920,
      sourceHeight: 1080,
      crop: { width: 1920, height: 800, x: 0, y: 140 },
      containerWidth: 2400,
      containerHeight: 1000,
      fit: 'contain',
    });
    expect(style).toEqual({ width: 2400, height: 1350, translateX: 0, translateY: -175 });
  });

  it('contain: crop narrower than the container AR — pillarboxed like a true server crop would be', () => {
    // Margin shows the source's own bars, not the container bg — same
    // pixels either way, since a detected crop's surround is black.
    const style = computeVideoCropStyle({
      sourceWidth: 1000,
      sourceHeight: 1000,
      crop: { width: 600, height: 1000, x: 200, y: 0 },
      containerWidth: 800,
      containerHeight: 400,
      fit: 'contain',
    });
    expect(style).toEqual({ width: 400, height: 400, translateX: 200, translateY: 0 });
  });

  it('cover: fills the container and clips the crop rectangle symmetrically', () => {
    const style = computeVideoCropStyle({
      sourceWidth: 3840,
      sourceHeight: 2160,
      crop: { width: 3840, height: 1620, x: 0, y: 270 },
      containerWidth: 1920,
      containerHeight: 1080,
      fit: 'cover',
    });
    expect(style).toEqual({ width: 2560, height: 1440, translateX: -320, translateY: -180 });
  });

  it('is null when the crop covers the whole frame (nothing to remove)', () => {
    const style = computeVideoCropStyle({
      sourceWidth: 1920,
      sourceHeight: 1080,
      crop: { width: 1920, height: 1080, x: 0, y: 0 },
      containerWidth: 1920,
      containerHeight: 1080,
      fit: 'contain',
    });
    expect(style).toBeNull();
  });

  it('is null for a zero-sized container (not yet laid out)', () => {
    const style = computeVideoCropStyle({
      sourceWidth: 3840,
      sourceHeight: 2160,
      crop: { width: 3840, height: 1648, x: 0, y: 256 },
      containerWidth: 0,
      containerHeight: 0,
      fit: 'contain',
    });
    expect(style).toBeNull();
  });

  it('is null for a degenerate (zero-sized) crop rectangle', () => {
    const style = computeVideoCropStyle({
      sourceWidth: 1920,
      sourceHeight: 1080,
      crop: { width: 0, height: 0, x: 0, y: 0 },
      containerWidth: 1920,
      containerHeight: 1080,
      fit: 'contain',
    });
    expect(style).toBeNull();
  });
});
