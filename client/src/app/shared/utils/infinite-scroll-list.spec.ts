import { describe, expect, it, vi } from 'vitest';
import type { CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { InfiniteScrollList } from './infinite-scroll-list';

interface Item {
  id: number;
  name: string;
}

function list(): InfiniteScrollList<Item> {
  const l = new InfiniteScrollList<Item>();
  l.setItems(['Alpha', 'Avocado', 'Bravo', 'Charlie', 'Delta'].map((name, i) => ({ id: i + 1, name })), (p) => p.name);
  l.grid.cols.set(2);
  l.grid.rowHeight.set(100);
  return l;
}

describe('InfiniteScrollList', () => {
  it('chunks the items into rows of the measured column count', () => {
    expect(list().grid.rows().map((r) => r.items.map((p) => p.id))).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('jumps to the row of a letter, measured from the document', () => {
    const l = list();
    const host = document.createElement('div');
    host.getBoundingClientRect = () => ({ top: 50 }) as DOMRect;
    const scrollToOffset = vi.fn();
    l.bindViewport({ elementRef: { nativeElement: host }, scrollToOffset, measureScrollOffset: () => 0 } as unknown as CdkVirtualScrollViewport);

    l.scrollToLetter('C', (p) => p.name);

    // Charlie is the third item: the second row, 50 px down the document.
    expect(scrollToOffset).toHaveBeenCalledWith(100 + 50 + window.scrollY, 'instant');
    expect(l.activeLetter()).toBe('C');
  });
});
