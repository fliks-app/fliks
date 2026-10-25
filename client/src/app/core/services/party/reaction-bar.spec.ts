import { MAX_BAR, sanitizeBar, toggleBar } from './reaction-bar';

describe('reaction bar', () => {
  const letters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  const known = new Set(letters);
  const defaults = ['a', 'b'];

  it('falls back to the defaults without a stored bar', () => {
    expect(sanitizeBar(null, known, defaults)).toEqual(['a', 'b']);
  });

  it('drops emojis outside the emoji data, and duplicates', () => {
    expect(sanitizeBar(['c', 'x', 'c', 'd'], known, defaults)).toEqual(['c', 'd']);
  });

  it('keeps the stored bar as is while the emoji data is not loaded', () => {
    expect(sanitizeBar(['c', 'x'], null, defaults)).toEqual(['c', 'x']);
  });

  it('falls back to the defaults when nothing valid is left', () => {
    expect(sanitizeBar(['x'], known, defaults)).toEqual(['a', 'b']);
  });

  it('adds in order and removes', () => {
    expect(toggleBar(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleBar(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('refuses a ninth emoji', () => {
    expect(toggleBar(letters.slice(0, MAX_BAR), 'i')).toBeNull();
  });

  it('refuses to empty the bar', () => {
    expect(toggleBar(['a'], 'a')).toBeNull();
  });
});
