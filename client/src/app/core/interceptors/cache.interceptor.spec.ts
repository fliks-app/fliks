import { HttpRequest, HttpResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import {
  CacheEntry,
  cacheInterceptor,
  clearRequestCache,
  invalidatePrefix,
  isCacheable,
  readPlan,
} from './cache.interceptor';

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

  // The connection is module state: a spec that ran earlier in the same worker may have opened it.
  beforeEach(async () => {
    open = vi.fn(() => ({}));
    vi.stubGlobal('indexedDB', { open });
    await clearRequestCache();
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

describe('cache.interceptor — read plan', () => {
  const entry = (url: string, ageMs: number): CacheEntry => ({ url, body: [], timestamp: Date.now() - ageMs });

  // The stubbed open never settles: only the synchronous, in-memory half of each call runs.
  beforeEach(() => {
    vi.stubGlobal('indexedDB', { open: vi.fn(() => ({})) });
    void clearRequestCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('serves a fresh entry and revalidates an expired one in background', () => {
    expect(readPlan(entry('/api/media?libraryId=1', 1_000), false)).toBe('cached');
    expect(readPlan(entry('/api/media?libraryId=1', 10 * 60_000), false)).toBe('revalidate');
    expect(readPlan(null, false)).toBe('network');
  });

  it('sends an invalidated entry to the network but keeps it for a known read', () => {
    const grid = entry('/api/media?libraryId=1', 1_000);
    const other = entry('/api/playback/watched-ids', 1_000);
    void invalidatePrefix('/api/media');
    expect(readPlan(grid, false)).toBe('network');
    expect(readPlan(grid, true)).toBe('cached');
    expect(readPlan(other, false)).toBe('cached');
  });

  it('treats a body fetched after the invalidation as fresh', () => {
    void invalidatePrefix('/api/media');
    expect(readPlan(entry('/api/media/12', -1), false)).toBe('cached');
  });

  it('keeps a known body whatever its age', () => {
    expect(readPlan(entry('/api/media?libraryId=1', 90 * 24 * 60 * 60_000), true)).toBe('cached');
  });
});
