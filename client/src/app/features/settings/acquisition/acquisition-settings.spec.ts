import { placeVisible } from './acquisition-settings';

describe('placeVisible', () => {
  it('keeps a provider that is down in its place while the others move', () => {
    expect(placeVisible(['a', 'down', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'down', 'a', 'b']);
  });

  it('appends a shown provider the stored order does not name', () => {
    expect(placeVisible(['a'], ['a', 'new'])).toEqual(['a', 'new']);
    expect(placeVisible([], ['b', 'a'])).toEqual(['b', 'a']);
  });

  it('is the stored order when nothing moved', () => {
    expect(placeVisible(['x', 'a', 'y', 'b'], ['a', 'b'])).toEqual(['x', 'a', 'y', 'b']);
  });
});
