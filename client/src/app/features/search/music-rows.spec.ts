import { describe, expect, it } from 'vitest';
import type { ArtistHit, RecordingHit, SearchHit } from '../../core/services/api/metadata.service';
import { musicItems, rowState, topResult, type MusicSources } from './music-rows';

const album = (id: string, extra: Partial<SearchHit> = {}) =>
  ({ provider: 'mb', externalId: id, mediaType: 'album', title: id, year: null, posterUrl: null, existingMediaId: null, ...extra }) as SearchHit;
const rec = (id: string, extra: Partial<RecordingHit> = {}) =>
  ({ provider: 'mb', externalId: id, title: id, artists: [], durationMs: null, album: album('g'), existingMediaId: null, state: null, trackId: null, ...extra }) as RecordingHit;
const src = (extra: Partial<MusicSources> = {}): MusicSources => ({ localTracks: [], recordings: [], localAlbums: [], albumHits: [], localArtists: [], artistHits: [], ...extra });

describe('rowState', () => {
  it('maps the library state, then the request of the caller', () => {
    expect(rowState({ state: 'owned' })).toBe('owned');
    expect(rowState({ requestStatus: 'available' })).toBe('owned');
    expect(rowState({ state: 'downloading' })).toBe('downloading');
    expect(rowState({ state: 'wanted' })).toBe('pending');
    expect(rowState({ requestStatus: 'approved' })).toBe('pending');
    expect(rowState({ requestStatus: 'declined' })).toBe('failed');
    expect(rowState({ state: 'missing' })).toBe('add');
    expect(rowState({})).toBe('add');
  });
});

describe('musicItems', () => {
  it('keeps a hit the library already shows out of the list', () => {
    const items = musicItems(
      src({
        localTracks: [{ itemId: 4, mediaId: 9, title: 'One', artists: [], albumTitle: 'A', hasFile: true, durationSeconds: 1, posterUrl: null } as never],
        recordings: [rec('a', { existingMediaId: 9, trackId: 4 }), rec('b')],
        localAlbums: [{ id: 9, title: 'A', year: 2000, posterUrl: null } as never],
        albumHits: [album('x', { existingMediaId: 9 }), album('y')],
        localArtists: [{ id: 3, name: 'N', avatarUrl: null } as never],
        artistHits: [{ provider: 'mb', externalId: 'p', name: 'N', personId: 3 } as ArtistHit, { provider: 'mb', externalId: 'q', name: 'M', personId: null } as ArtistHit],
      }),
    );
    expect(items.tracks.map((t) => t.title)).toEqual(['One', 'b']);
    expect(items.albums.map((a) => a.key)).toEqual(['m:9', 'a:mb:y']);
    expect(items.artists.map((a) => a.title)).toEqual(['N', 'M']);
    expect(items.tracks[0]!.state).toBe('owned');
  });
});

describe('topResult', () => {
  const items = musicItems(
    src({
      recordings: [rec('first'), rec('Second')],
      albumHits: [album('Abbey')],
      artistHits: [{ provider: 'mb', externalId: 'p', name: 'Abbey', personId: null } as ArtistHit],
    }),
  );
  it('prefers the artist named like the query, then the album, then the first track', () => {
    expect(topResult(' abbey ', items)?.kind).toBe('artist');
    expect(topResult('abbey', { ...items, artists: [] })?.kind).toBe('album');
    expect(topResult('zzz', items)?.title).toBe('first');
    expect(topResult('zzz', { tracks: [], albums: items.albums, artists: [] })).toBeNull();
  });
});
