import { StreamingApiService } from './streaming-api.service';

/**
 * The six subtitle / thumbnail URL builders share one `streamUrl` helper, so a
 * mistake there breaks playback everywhere at once. Exercised on a bare
 * prototype: they read only `serverConfig` and the token getter.
 */
function build(opts: { isNative?: boolean; token?: string | null } = {}) {
  const service = Object.create(StreamingApiService.prototype) as StreamingApiService;
  const wired = service as unknown as {
    serverConfig: unknown;
    auth: unknown;
  };
  wired.serverConfig = {
    isNative: opts.isNative ?? false,
    resolveUrl: (p: string) => `https://server.test${p}`,
  };
  wired.auth = {
    streamToken: () => (opts.token === undefined ? 'tok' : opts.token),
    accessToken: null,
  };
  return service;
}

describe('StreamingApiService subtitle URLs', () => {
  it('appends the playback token to the relative path', () => {
    expect(build().getSubtitleUrl(7, 42)).toBe('/api/stream/7/subtitles/42?token=tok');
  });

  it('resolves against the server when running native', () => {
    expect(build({ isNative: true }).getSubtitleUrl(7, 42)).toBe(
      'https://server.test/api/stream/7/subtitles/42?token=tok',
    );
  });

  it('omits the query when there is no token', () => {
    expect(build({ token: null }).getSubtitleUrl(7, 42)).toBe('/api/stream/7/subtitles/42');
  });

  it('points the download variants at the /download route', () => {
    const s = build();
    expect(s.getSubtitleDownloadUrl(7, 42)).toBe('/api/stream/7/subtitles/42/download?token=tok');
    expect(s.getEmbeddedSubtitleDownloadUrl(7, 3)).toBe(
      '/api/stream/7/subtitles/embedded/3/download?token=tok',
    );
  });

  it('keeps the embedded playback route distinct from its download route', () => {
    expect(build().getEmbeddedSubtitleUrl(7, 3)).toBe(
      '/api/stream/7/subtitles/embedded/3?token=tok',
    );
  });

  it('still builds the thumbnail URLs off the same helper', () => {
    const s = build();
    expect(s.getThumbnailSpriteUrl(7)).toBe('/api/stream/7/thumbnails/sprite.jpg?token=tok');
    expect(s.getThumbnailMetadataUrl(7)).toBe('/api/stream/7/thumbnails/sprite.json?token=tok');
  });
});
