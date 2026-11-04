import { pageAt, pageCount, screenIndex } from './reader-pages';

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
