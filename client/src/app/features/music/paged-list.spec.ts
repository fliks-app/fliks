import { describe, expect, it } from 'vitest';
import { PagedList } from './paged-list';

describe('PagedList', () => {
  it('appends the next page while pages come back full, then stops', async () => {
    const pages = [[1, 2], [3, 4], [5]];
    const list = new PagedList<number>(async (page) => pages[page - 1]!, 2);
    await list.load();
    expect(list.more()).toBe(true);
    await list.loadMore();
    await list.loadMore();
    expect(list.rows()).toEqual([1, 2, 3, 4, 5]);
    expect(list.more()).toBe(false);
  });

  it('drops the answer of a request a newer one replaced', async () => {
    const resolvers: ((v: number[]) => void)[] = [];
    const list = new PagedList<number>(() => new Promise((r) => resolvers.push(r)), 10);
    const first = list.load();
    const second = list.load();
    resolvers[1]!([2]);
    resolvers[0]!([1]);
    await Promise.all([first, second]);
    expect(list.rows()).toEqual([2]);
    expect(list.loading()).toBe(false);
  });
});
