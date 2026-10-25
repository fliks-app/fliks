import { describe, it, expect } from 'vitest';
import { backTarget } from './back-target';

const movie = { mediaId: 7, kind: 'movies' as const };
const ep = { mediaId: 9, kind: 'series' as const, episodeId: 3 };

describe('backTarget', () => {
  it('returns the page that opened the player', () => {
    expect(backTarget({ ...movie, origin: '/parties/40' })).toBe('/parties/40');
    expect(backTarget({ ...movie, origin: '/search?q=a' })).toBe('/search?q=a');
    expect(backTarget({ ...ep, origin: '/downloads' })).toBe('/downloads');
    expect(backTarget({ ...ep, origin: '/playlists/5', landingEpisodeId: 4 })).toBe('/playlists/5');
  });
  it('falls back to the detail page without an origin', () => {
    expect(backTarget({ ...movie, origin: null })).toBe('/movies/7');
    expect(backTarget({ ...ep, origin: null })).toBe('/series/9/episode/3');
  });
  it('sends a finished episode to the next one from its own pages', () => {
    expect(backTarget({ ...ep, origin: '/series/9', landingEpisodeId: 4 })).toBe('/series/9/episode/4');
    expect(backTarget({ ...ep, origin: '/series/9/episode/3', landingEpisodeId: 4 })).toBe('/series/9/episode/4');
  });
  it('keeps another media page as the origin', () => {
    expect(backTarget({ ...movie, origin: '/movies/8' })).toBe('/movies/8');
  });
  it('goes home or to the origin without media', () => {
    expect(backTarget({ mediaId: 0, kind: 'movies', origin: null })).toBe('/');
    expect(backTarget({ mediaId: 0, kind: 'movies', origin: '/parties/1' })).toBe('/parties/1');
  });
});
