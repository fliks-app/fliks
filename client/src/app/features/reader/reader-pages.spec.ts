import { loadCounts, pageAt, pageCount, saveCounts, screenIndex } from './reader-pages';

const order = ['a', 'b', 'c'];

describe('reader pages', () => {
  it('numbers a screen from the chapters before it', () => {
    const counts = new Map([['a', 3], ['b', 4], ['c', 2]]);
    expect(pageAt(order, counts, 'b', 0)).toEqual({ page: 4, left: 3 });
    expect(pageAt(order, counts, 'b', 1)).toEqual({ page: 7, left: 0 });
    expect(pageCount(order, counts)).toBe(9);
  });

  it('gives no number while a chapter on the way is not counted', () => {
    const counts = new Map([['a', 3], ['c', 2]]);
    expect(pageAt(order, counts, 'c', 0)).toBeNull();
    expect(pageCount(order, counts)).toBeNull();
  });

  it('maps the progression of a one-screen chapter to its only screen', () => {
    expect(screenIndex(0.7, 1)).toBe(0);
  });
});

describe('page count cache', () => {
  beforeEach(() => localStorage.clear());

  it('answers a book only for its own scope and layout signature', () => {
    saveCounts('server-a', 7, 'sig', new Map([['a.xhtml', 3]]));
    expect([...loadCounts('server-a', 7, 'sig')]).toEqual([['a.xhtml', 3]]);
    expect(loadCounts('server-b', 7, 'sig').size).toBe(0);
    expect(loadCounts('server-a', 7, 'other').size).toBe(0);
  });

  it('keeps only the most recently paginated books', () => {
    for (let id = 1; id <= 31; id++) saveCounts('s', id, 'sig', new Map([['a.xhtml', id]]));
    expect(loadCounts('s', 1, 'sig').size).toBe(0);
    expect(loadCounts('s', 31, 'sig').get('a.xhtml')).toBe(31);
  });
});
