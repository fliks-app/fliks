import { describe, expect, it } from 'vitest';
import type { Media } from '../../core/services/api/media.service';
import { albumRows, playlistRows, trackRow } from './party-programme-items';

const album = {
  id: 4,
  type: 'album',
  title: 'Al',
  posterUrl: '/p.jpg',
  album: {
    targetEditionId: 2,
    editions: [{ id: 1, hasFiles: true }, { id: 2, hasFiles: true }],
    tracks: [
      { itemId: 10, editionId: 1, hasFile: true, title: 'Other edition' },
      { itemId: 20, editionId: 2, hasFile: true, title: 'A' },
      { itemId: 21, editionId: 2, hasFile: false, title: 'No file' },
      { itemId: 22, editionId: 2, hasFile: true, title: 'B' },
    ],
  },
} as unknown as Media;

describe('programme expansion', () => {
  it('expands an album into the playable tracks of its default edition, in order', () => {
    expect(albumRows(album).map((r) => [r.mediaId, r.itemId, r.title, r.seriesTitle])).toEqual([
      [4, 20, 'A', 'Al'],
      [4, 22, 'B', 'Al'],
    ]);
  });

  it('gives nothing for a missing or non-album media', () => {
    expect(albumRows(null)).toEqual([]);
    expect(albumRows({ id: 1, type: 'movie' } as Media)).toEqual([]);
  });

  it('turns a track search hit into a row of its album', () => {
    expect(trackRow({ mediaId: 4, itemId: 9, title: 'T', albumTitle: 'Al', posterUrl: null })).toEqual({
      mediaId: 4, episodeId: null, itemId: 9, title: 'T', seriesTitle: 'Al', posterUrl: null,
    });
  });

  it('expands a playlist: tracks by item, videos by media and episode', () => {
    const rows = playlistRows([
      { media: { id: 4, title: 'Al', posterUrl: null }, track: { itemId: 20, title: 'A' } },
      { media: { id: 7, title: 'Show', posterUrl: '/s' }, episode: { id: 70 } },
      { media: { id: 8, title: 'Film', posterUrl: null }, episode: null },
    ]);
    expect(rows.map((r) => [r.mediaId, r.episodeId, r.itemId ?? null, r.title])).toEqual([
      [4, null, 20, 'A'],
      [7, 70, null, 'Show'],
      [8, null, null, 'Film'],
    ]);
  });
});
