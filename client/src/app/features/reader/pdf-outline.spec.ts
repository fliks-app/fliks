import { describe, expect, it } from 'vitest';
import { flattenOutline, outlineEntries, outlineRowAt } from './pdf-outline';

describe('pdf outline', () => {
  const pageOf = async (dest: unknown) => (typeof dest === 'number' ? dest : null);

  it('flattens nested entries in order and drops those that point nowhere or have no title', async () => {
    const rows = await flattenOutline(
      [
        { title: 'One', dest: 1, items: [{ title: ' Sub ', dest: 3 }, { title: 'Dead', dest: 'x' }] },
        { title: '  ', dest: 5 },
        { title: 'Two', dest: 8 },
      ],
      pageOf,
    );
    expect(rows).toEqual([
      { title: 'One', depth: 0, page: 1 },
      { title: 'Sub', depth: 1, page: 3 },
      { title: 'Two', depth: 0, page: 8 },
    ]);
  });

  it('runs each entry to the next one and the last to the end', () => {
    const e = outlineEntries([{ title: 'A', depth: 0, page: 1 }, { title: 'B', depth: 0, page: 6 }], 11);
    expect(e.map((x) => [x.start, x.end])).toEqual([[0, 0.5], [0.5, 1]]);
  });

  it('finds the row of a page', () => {
    const rows = [{ title: 'A', depth: 0, page: 2 }, { title: 'B', depth: 0, page: 6 }];
    expect([1, 2, 5, 6, 9].map((p) => outlineRowAt(rows, p))).toEqual([-1, 0, 0, 1, 1]);
  });
});
