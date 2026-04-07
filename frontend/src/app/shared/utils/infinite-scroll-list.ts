import { signal, ElementRef } from '@angular/core';

const DEFAULT_BATCH_SIZE = 60;

export class InfiniteScrollList<T extends { id: number }> {
  private allItems: T[] = [];
  private visibleCount = 0;
  private observer?: IntersectionObserver;
  private readonly batchSize: number;

  /** All items (reactive — use in computed for counts/stats). */
  readonly all = signal<T[]>([]);
  readonly visible = signal<T[]>([]);
  readonly total = signal(0);
  readonly hasMore = signal(false);

  constructor(batchSize = DEFAULT_BATCH_SIZE) {
    this.batchSize = batchSize;
  }

  /** Replace all items and reset visible window. */
  setItems(items: T[]) {
    this.allItems = items;
    this.all.set(items);
    this.total.set(items.length);
    this.visibleCount = this.batchSize;
    this.updateVisible();
  }

  /** Get all items (non-reactive — use `all()` signal for computed). */
  getAll(): T[] {
    return this.allItems;
  }

  /** Load next batch. */
  showMore() {
    if (this.visibleCount >= this.allItems.length) return;
    this.visibleCount = Math.min(
      this.visibleCount + this.batchSize,
      this.allItems.length,
    );
    this.updateVisible();
  }

  /**
   * Scroll to the first item matching a letter.
   * @param letter   The alphabet letter (or '#' for non-alpha).
   * @param titleFn  Extract the sortable title from an item.
   * @param idPrefix DOM id prefix (e.g. 'movie', 'person').
   */
  scrollToLetter(
    letter: string,
    titleFn: (item: T) => string,
    idPrefix: string,
  ) {
    const index = this.allItems.findIndex((item) => {
      const firstChar = (titleFn(item) || '').charAt(0).toUpperCase();
      if (letter === '#') return !/[A-Z]/.test(firstChar);
      return firstChar === letter;
    });
    if (index < 0) return;
    if (index >= this.visibleCount) {
      this.visibleCount = Math.min(
        index + this.batchSize,
        this.allItems.length,
      );
      this.updateVisible();
    }
    requestAnimationFrame(() => {
      const target = document.getElementById(
        `${idPrefix}-${this.allItems[index].id}`,
      );
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  /** Bind to a sentinel element via @ViewChild setter. */
  observeSentinel(ref: ElementRef<HTMLElement> | undefined) {
    this.observer?.disconnect();
    if (ref) {
      this.observer = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting) this.showMore();
        },
        { rootMargin: '400px' },
      );
      this.observer.observe(ref.nativeElement);
    }
  }

  /** Call in ngOnDestroy. */
  destroy() {
    this.observer?.disconnect();
  }

  private updateVisible() {
    this.visible.set(this.allItems.slice(0, this.visibleCount));
    this.hasMore.set(this.visibleCount < this.allItems.length);
  }
}
