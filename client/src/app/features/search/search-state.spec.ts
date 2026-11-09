import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { SearchStateService } from '../../core/services/search-state.service';
import type { ArtistHit, RecordingHit, SearchHit } from '../../core/services/api/metadata.service';

const hit = (id: string, extra: Partial<SearchHit> = {}): SearchHit =>
  ({ provider: 'tmdb', externalId: id, mediaType: 'movie', title: id, year: null, posterUrl: null, existingMediaId: null, rating: 1, ...extra }) as SearchHit;

describe('the two zones of the search state', () => {
  let s: SearchStateService;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    s = TestBed.inject(SearchStateService);
  });

  it('keeps a title the library holds out of "not in your library"', () => {
    s.localResults.set([{ id: 5 } as never]);
    s.movieHits.set([hit('1', { existingMediaId: 5 }), hit('2', { existingMediaId: 6 }), hit('3')]);
    expect(s.videoToAdd().map((h) => h.externalId)).toEqual(['3']);
    expect(s.videoHeld().map((h) => h.externalId)).toEqual(['2']);
  });

  it('keeps a held album and a held artist out of the provider zone, and an owned track out of its list', () => {
    s.localResults.set([{ id: 9 } as never]);
    s.albumHits.set([hit('a', { mediaType: 'album', existingMediaId: 9 }), hit('b', { mediaType: 'album' })]);
    s.localArtists.set([{ id: 3 } as never]);
    s.artistHits.set([{ externalId: 'x', personId: 3 } as ArtistHit, { externalId: 'y', personId: null } as ArtistHit]);
    s.recordingHits.set([{ externalId: 'r1', trackId: 4 } as RecordingHit, { externalId: 'r2', trackId: null } as RecordingHit]);
    expect(s.albumsToAdd().map((h) => h.externalId)).toEqual(['b']);
    expect(s.albumsHeld()).toEqual([]);
    expect(s.artistsToAdd().map((a) => a.externalId)).toEqual(['y']);
    expect(s.recordingsToAdd().map((r) => r.externalId)).toEqual(['r2']);
  });

  it('merges movies and series best rated first', () => {
    s.movieHits.set([hit('m', { rating: 5 })]);
    s.seriesHits.set([hit('s', { rating: 8 })]);
    expect(s.externalResults().map((h) => h.externalId)).toEqual(['s', 'm']);
  });
});
