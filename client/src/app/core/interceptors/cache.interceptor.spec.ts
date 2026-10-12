import { HttpRequest, HttpResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { cacheInterceptor, isCacheable } from './cache.interceptor';

describe('cache.interceptor — what may be cached', () => {
  it('caches the core reads it was built for', () => {
    expect(isCacheable('/api/media/12')).toBe(true);
    expect(isCacheable('/api/libraries/mine')).toBe(true);
    expect(isCacheable('/api/profiles/quality')).toBe(true);
  });

  it('never caches a plugin route, whatever the cacheable list grows to', () => {
    expect(isCacheable('/api/plugins/fliks.acme/42/releases')).toBe(false);
    expect(isCacheable('/api/plugins/fliks.acme/queue')).toBe(false);
    expect(isCacheable('/api/plugins/ui')).toBe(false);
  });

  it('refuses the metadata lists that carry library state, keeps the pure reads', () => {
    expect(isCacheable('/api/metadata/trending/movie?window=week')).toBe(false);
    expect(isCacheable('/api/metadata/popular/tv')).toBe(false);
    expect(isCacheable('/api/metadata/discover/movie?genres=28')).toBe(false);
    expect(isCacheable('/api/metadata/search/movie?q=foo')).toBe(false);
    expect(isCacheable('/api/metadata/tmdb/movie/123')).toBe(true);
    expect(isCacheable('/api/metadata/genres/movie')).toBe(true);
  });

  it('refuses auth, streams and live subtitle searches', () => {
    expect(isCacheable('/api/auth/me')).toBe(false);
    expect(isCacheable('/api/stream/1')).toBe(false);
    expect(isCacheable('/api/media/42/subtitles/search')).toBe(false);
  });
});

describe('cache.interceptor — mutations', () => {
  const post = new HttpRequest('POST', '/api/playback/progress', {});
  let open: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    open = vi.fn(() => ({}));
    vi.stubGlobal('indexedDB', { open });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the cache when the mutation never reaches the server', () => {
    cacheInterceptor(post, () => throwError(() => ({ status: 0 }))).subscribe({ error: () => undefined });
    expect(open).not.toHaveBeenCalled();
  });

  it('invalidates once the server accepted the mutation', () => {
    cacheInterceptor(post, () => of(new HttpResponse({ status: 204 }))).subscribe();
    expect(open).toHaveBeenCalled();
  });
});
