import { orderQueue } from './singer-queue';

const q = (...s: number[]) => s.map((singerId, id) => ({ id, singerId }));

describe('orderQueue', () => {
  it('interleaves singers', () => {
    expect(orderQueue(q(1, 1, 1, 2, 3, 2)).map((e) => e.id)).toEqual([0, 3, 4, 1, 5, 2]);
  });
  it('puts the singer who sang least recently first in a round', () => {
    const out = orderQueue(q(1, 2), new Map([[1, 500], [2, 100]]));
    expect(out.map((e) => e.singerId)).toEqual([2, 1]);
  });
  it('keeps a lone singer in order', () => {
    expect(orderQueue(q(7, 7, 7)).map((e) => e.id)).toEqual([0, 1, 2]);
  });
});
