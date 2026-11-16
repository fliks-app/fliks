import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { SearchStateService } from '../../core/services/search-state.service';
import type { SearchHit } from '../../core/services/api/metadata.service';

const hit = (id: string, extra: Partial<SearchHit> = {}): SearchHit =>
  ({ provider: 'tmdb', externalId: id, mediaType: 'movie', title: id, year: null, posterUrl: null, existingMediaId: null, rating: 1, ...extra }) as SearchHit;

describe('the video zones of the search state', () => {
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

  it('merges movies and series best rated first', () => {
    s.movieHits.set([hit('m', { rating: 5 })]);
    s.seriesHits.set([hit('s', { rating: 8 })]);
    expect(s.externalResults().map((h) => h.externalId)).toEqual(['s', 'm']);
  });
});
