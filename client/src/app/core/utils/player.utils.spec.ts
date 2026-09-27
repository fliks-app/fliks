import { deliveredKindFromVariant } from './player.utils';

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
