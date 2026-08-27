import { describe, it, expect } from 'vitest';
import { imageUrlWithSize } from './resolve-url.pipe';

/**
 * Stored artwork URLs carry a `?v=<content hash>` so a re-identified media does
 * not keep serving the old bytes out of the HTTP cache, the service worker or
 * the native image cache — all three key on the URL.
 */
describe('imageUrlWithSize', () => {
  it('VERDICT: keeps the version and adds the size as a second parameter', () => {
    expect(imageUrlWithSize('/api/images/media/795/poster?v=1a2b3c4d', 'thumb')).toBe(
      '/api/images/media/795/poster?v=1a2b3c4d&size=thumb',
    );
  });

  it('starts the query string when the URL has none', () => {
    expect(imageUrlWithSize('/api/images/media/795/poster', 'medium')).toBe(
      '/api/images/media/795/poster?size=medium',
    );
  });

  it('leaves a remote URL alone', () => {
    const remote = 'https://image.tmdb.org/t/p/w500/x.jpg';
    expect(imageUrlWithSize(remote, 'thumb')).toBe(remote);
  });
});
