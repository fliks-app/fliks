import { MAX_BAR, sanitizeBar, toggleBar } from './reaction-bar';

describe('reaction bar', () => {
  const catalog = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  const defaults = ['a', 'b'];

  it('falls back to the defaults without a stored bar', () => {
    expect(sanitizeBar(null, catalog, defaults)).toEqual(['a', 'b']);
  });

  it('drops emojis the catalog no longer has, and duplicates', () => {
    expect(sanitizeBar(['c', 'x', 'c', 'd'], catalog, defaults)).toEqual(['c', 'd']);
  });

  it('falls back to the defaults when nothing valid is left', () => {
    expect(sanitizeBar(['x'], catalog, defaults)).toEqual(['a', 'b']);
  });

  it('adds in order and removes', () => {
    expect(toggleBar(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleBar(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('refuses a ninth emoji', () => {
    expect(toggleBar(catalog.slice(0, MAX_BAR), 'i')).toBeNull();
  });

  it('refuses to empty the bar', () => {
    expect(toggleBar(['a'], 'a')).toBeNull();
  });
});
