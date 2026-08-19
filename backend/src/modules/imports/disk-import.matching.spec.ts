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
    const rows = [media('The Long Voyage')];
    expect(matchMedia('the long voyage', rows)?.title).toBe('The Long Voyage');
    expect(matchMedia('The  Long   Voyage!', rows)?.title).toBe('The Long Voyage');
  });

  it('matches the original title too', () => {
    const rows = [media('The Long Voyage', 'Le Long Voyage')];
    expect(matchMedia('le long voyage', rows)?.title).toBe('The Long Voyage');
  });

  it('accepts a filename carrying trailing noise', () => {
    const rows = [media('The Long Voyage')];
    expect(matchMedia('the long voyage 2011', rows)?.title).toBe('The Long Voyage');
  });

  it('accepts a truncated filename against a longer library title', () => {
    expect(matchMedia('voy', [media('Voyager')])?.title).toBe('Voyager');
  });

  it('refuses to let a two-letter library title absorb a shorter fragment', () => {
    // The length guard sits on the library title, not on the filename.
    expect(matchMedia('v', [media('Vo')])).toBeNull();
    expect(matchMedia('v', [media('Voy')])?.title).toBe('Voy');
  });

  it('prefers an exact hit over a prefix one, whatever the order', () => {
    const rows = [media('Voyager'), media('Voy')];
    expect(matchMedia('voy', rows)?.title).toBe('Voy');
  });

  it('returns null on an empty target or no candidate', () => {
    expect(matchMedia('', [media('Voyager')])).toBeNull();
    expect(matchMedia('something else', [media('Voyager')])).toBeNull();
  });
});
