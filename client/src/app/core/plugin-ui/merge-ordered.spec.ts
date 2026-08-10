import { mergeOrdered } from './merge-ordered';

interface Item {
  key: string;
  visible: boolean;
}

const item = (key: string, visible = true): Item => ({ key, visible });
const keys = (items: Item[]) => items.map((i) => i.key);

describe('mergeOrdered', () => {
  it('keeps the saved order for items still available', () => {
    const saved = [item('c'), item('a'), item('b')];
    const available = new Set(['a', 'b', 'c']);
    expect(keys(mergeOrdered(saved, [], available, (i) => i.key))).toEqual(['c', 'a', 'b']);
  });

  it('appends items the user never saw, in canonical (defaults) order', () => {
    const saved = [item('b')];
    const defaults = [item('a'), item('b'), item('c')];
    const available = new Set(['a', 'b', 'c']);
    expect(keys(mergeOrdered(saved, defaults, available, (i) => i.key))).toEqual(['b', 'a', 'c']);
  });

  it('drops saved items that are no longer available', () => {
    const saved = [item('a'), item('gone'), item('b')];
    const available = new Set(['a', 'b']);
    expect(keys(mergeOrdered(saved, [], available, (i) => i.key))).toEqual(['a', 'b']);
  });

  it('preserves the saved item, not the default, on a key collision', () => {
    const saved = [item('a', false)];
    const defaults = [item('a', true)];
    const available = new Set(['a']);
    const result = mergeOrdered(saved, defaults, available, (i) => i.key);
    expect(result).toEqual([item('a', false)]);
  });

  it('drops a duplicate key in the saved list itself', () => {
    const saved = [item('a'), item('a')];
    const available = new Set(['a']);
    expect(keys(mergeOrdered(saved, [], available, (i) => i.key))).toEqual(['a']);
  });

  it('never appends a default that is not in the available set', () => {
    const defaults = [item('a'), item('b')];
    const available = new Set(['a']);
    expect(keys(mergeOrdered([], defaults, available, (i) => i.key))).toEqual(['a']);
  });

  it('returns an empty list when nothing is saved, defaulted or available', () => {
    expect(mergeOrdered([], [], new Set(), (i: Item) => i.key)).toEqual([]);
  });
});
