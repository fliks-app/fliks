import { describe, it, expect } from 'vitest';
import { imageUrlWithSize, withLiveTvLogoToken } from './resolve-url.pipe';

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

  it('also appends the size to a Live TV channel logo URL', () => {
    expect(imageUrlWithSize('/api/livetv/channels/12/logo', 'thumb')).toBe(
      '/api/livetv/channels/12/logo?size=thumb',
    );
  });
});

/**
 * A channel logo can belong to a restricted group, so — unlike every other
 * local image — its route requires an authenticated caller. A native/TV
 * client fetches it cross-origin and can't attach a header, so the token
 * rides in the query, same as an HLS segment URL.
 */
describe('withLiveTvLogoToken', () => {
  it('appends the token to a Live TV channel logo URL', () => {
    expect(withLiveTvLogoToken('/api/livetv/channels/12/logo', 'tok')).toBe(
      '/api/livetv/channels/12/logo?token=tok',
    );
  });

  it('appends after an existing query string', () => {
    expect(withLiveTvLogoToken('/api/livetv/channels/12/logo?size=thumb', 'tok')).toBe(
      '/api/livetv/channels/12/logo?size=thumb&token=tok',
    );
  });

  it('leaves a non-logo URL alone', () => {
    expect(withLiveTvLogoToken('/api/images/media/795/poster', 'tok')).toBe(
      '/api/images/media/795/poster',
    );
  });

  it('leaves the URL alone when there is no token', () => {
    expect(withLiveTvLogoToken('/api/livetv/channels/12/logo', null)).toBe(
      '/api/livetv/channels/12/logo',
    );
  });
});
