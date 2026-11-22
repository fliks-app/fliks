import { TestBed } from '@angular/core/testing';
import { RecentSearchesService } from './recent-searches.service';

describe('RecentSearchesService', () => {
  beforeEach(() => localStorage.removeItem('fliks-recent-searches'));

  it('keeps 5 terms, newest first, without case duplicates', () => {
    const s = TestBed.inject(RecentSearchesService);
    for (const t of ['a', 'b', 'c', 'd', 'e', 'f', 'C']) s.add(t);
    expect(s.terms()).toEqual(['C', 'f', 'e', 'd', 'b']);
  });

  it('ignores blanks and clears', () => {
    const s = TestBed.inject(RecentSearchesService);
    s.add('  ');
    expect(s.terms()).toEqual([]);
    s.add('x');
    s.clear();
    expect(s.terms()).toEqual([]);
    expect(localStorage.getItem('fliks-recent-searches')).toBe('[]');
  });
});
