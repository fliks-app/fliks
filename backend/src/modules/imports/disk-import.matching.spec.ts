import { matchMedia, normalizeTitle } from './disk-import.service';

const media = (title: string, originalTitle = '') => ({
  title,
  normTitle: normalizeTitle(title),
  normOriginal: normalizeTitle(originalTitle),
});

describe('disk scan — matching a filename to a library title', () => {
  // Callers hand over the output of extractTitle, which has already turned
  // dots and underscores into spaces.
  it('ignores case, punctuation and repeated spaces', () => {
    const rows = [media('Sample Movie')];
    expect(matchMedia('sample movie', rows)?.title).toBe('Sample Movie');
    expect(matchMedia('Sample  Movie!', rows)?.title).toBe('Sample Movie');
  });

  it('matches the original title too', () => {
    const rows = [media('Sample Movie', 'Sample Movie Original')];
    expect(matchMedia('sample movie original', rows)?.title).toBe('Sample Movie');
  });

  it('accepts a filename carrying trailing noise', () => {
    const rows = [media('Sample Movie')];
    expect(matchMedia('sample movie 2011', rows)?.title).toBe('Sample Movie');
  });

  it('accepts a truncated filename against a longer library title', () => {
    expect(matchMedia('epi', [media('Episode')])?.title).toBe('Episode');
  });

  it('refuses to let a two-letter library title absorb a shorter fragment', () => {
    // The length guard sits on the library title, not on the filename.
    expect(matchMedia('e', [media('Ep')])).toBeNull();
    expect(matchMedia('e', [media('Epi')])?.title).toBe('Epi');
  });

  it('prefers an exact hit over a prefix one, whatever the order', () => {
    const rows = [media('Episode'), media('Epi')];
    expect(matchMedia('epi', rows)?.title).toBe('Epi');
  });

  it('returns null on an empty target or no candidate', () => {
    expect(matchMedia('', [media('Episode')])).toBeNull();
    expect(matchMedia('something else', [media('Episode')])).toBeNull();
  });
});
