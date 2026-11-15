import { signal, computed, Signal, WritableSignal } from '@angular/core';
import type { CdkVirtualScrollViewport } from '@angular/cdk/scrolling';

export interface GridRow<T> {
  index: number;
  items: T[];
}

/** A card grid chunked into fixed-pitch rows for a window-scrolling CDK viewport, as the library grid renders;
 *  columns and pitch are read off a laid-out row, so the initial values only need to be plausible. */
export class VirtualGrid<T> {
  readonly cols = signal(6);
  readonly rowHeight: WritableSignal<number>;
  readonly rows: Signal<GridRow<T>[]>;
  private row?: HTMLElement;

  constructor(items: () => T[], rowHeight = 320) {
    this.rowHeight = signal(rowHeight);
    this.rows = computed(() => {
      const cols = this.cols();
      const all = items();
      const rows: GridRow<T>[] = [];
      for (let i = 0; i < all.length; i += cols) rows.push({ index: rows.length, items: all.slice(i, i + cols) });
      return rows;
    });
  }

  trackRow(_: number, row: GridRow<T>): number {
    return row.index;
  }

  /** Measures the first row of each layout only: the fixed-size strategy places rows at `index * itemSize`,
   *  and a row re-measured under a focus lift would skew that pitch. */
  bindRow(el: HTMLElement | undefined): void {
    const fresh = !this.row;
    this.row = el;
    if (fresh) this.measure();
  }

  /** Reads the columns and the pitch off the bound row; the row carries the gap below its cards. */
  measure(): void {
    const row = this.row;
    if (!row?.isConnected) return;
    const cs = getComputedStyle(row);
    const cols = cs.gridTemplateColumns.split(' ').filter((t) => t && t !== '0px').length;
    // The row is pinned to `rowHeight`, so measure a card, not the row.
    const cell = row.firstElementChild?.getBoundingClientRect().height ?? 0;
    if (cols < 1 || cell <= 0) return;
    this.cols.set(cols);
    this.rowHeight.set(cell + (parseFloat(cs.rowGap) || 0));
  }
}

/** A sorted list with an alphabet index, rendered through a {@link VirtualGrid}. */
export class InfiniteScrollList<T extends { id: number }> {
  private allItems: T[] = [];
  private titleFn: ((item: T) => string) | null = null;
  private letterBoundaries: { letter: string; index: number }[] = [];
  private scrollHandler: (() => void) | null = null;
  private scrollRaf: number | null = null;
  private viewport?: CdkVirtualScrollViewport;
  /** A letter jump outranks the scroll-driven recompute for a moment: the row it lands on often opens with the previous letter. */
  private letterHeldUntil = 0;
  private readonly idIndex = new Map<number, number>();

  /** All items (reactive: use in computed for counts/stats). */
  readonly all = signal<T[]>([]);
  readonly total = signal(0);
  /** Letters that have at least one item. */
  readonly availableLetters = signal<Set<string>>(new Set());
  /** Currently visible letter based on scroll position. */
  readonly activeLetter = signal('');
  readonly grid = new VirtualGrid<T>(() => this.all());

  /** Replace all items. */
  setItems(items: T[], titleFn?: (item: T) => string) {
    this.allItems = items;
    if (titleFn) this.titleFn = titleFn;
    this.all.set(items);
    this.total.set(items.length);
    this.idIndex.clear();
    for (let i = 0; i < items.length; i++) this.idIndex.set(items[i].id, i);
    this.recomputeLetters();
  }

  /** Get all items (non-reactive: use the `all()` signal for computed). */
  getAll(): T[] {
    return this.allItems;
  }

  /** The letter section of item `index`, read from the model since virtual scrolling renders only a few rows. */
  letterAt(index: number): string {
    let current = this.letterBoundaries[0]?.letter ?? '';
    for (const b of this.letterBoundaries) {
      if (b.index <= index) current = b.letter;
      else break;
    }
    return current;
  }

  /** Index of an item id in allItems, or -1. */
  indexOf(id: number): number {
    return this.idIndex.get(id) ?? -1;
  }

  /** The viewport rendering {@link grid}, from a `@ViewChild` setter. */
  bindViewport(viewport: CdkVirtualScrollViewport | undefined) {
    this.viewport = viewport;
    if (viewport) queueMicrotask(() => this.onScroll());
  }

  /** Coalesce scroll-driven work into one frame. */
  private scheduleScrollWork() {
    if (this.scrollRaf !== null) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = null;
      this.onScroll();
    });
  }

  /** Jump to the first item matching a letter ('#' for non-alpha). */
  scrollToLetter(letter: string, titleFn: (item: T) => string) {
    const index = this.allItems.findIndex((item) => {
      const firstChar = (titleFn(item) || '').charAt(0).toUpperCase();
      if (letter === '#') return !/[A-Z]/.test(firstChar);
      return firstChar === letter;
    });
    const vp = this.viewport;
    if (index < 0 || !vp) return;
    this.activeLetter.set(letter);
    this.letterHeldUntil = performance.now() + 600;
    const row = Math.floor(index / this.grid.cols());
    const rowsTop = vp.elementRef.nativeElement.getBoundingClientRect().top + window.scrollY;
    // Instant: the rows in between are not rendered, so an animated jump would cross blank space.
    vp.scrollToOffset(row * this.grid.rowHeight() + rowsTop, 'instant');
  }

  /** Start tracking scroll position to update activeLetter. Call once after init. */
  trackScroll() {
    if (this.scrollHandler) window.removeEventListener('scroll', this.scrollHandler);
    this.scrollHandler = () => this.scheduleScrollWork();
    window.addEventListener('scroll', this.scrollHandler, { passive: true });
  }

  /** Call in ngOnDestroy. */
  destroy() {
    if (this.scrollHandler) {
      window.removeEventListener('scroll', this.scrollHandler);
      this.scrollHandler = null;
    }
    if (this.scrollRaf !== null) {
      cancelAnimationFrame(this.scrollRaf);
      this.scrollRaf = null;
    }
  }

  private recomputeLetters() {
    if (!this.titleFn) return;
    const letters = new Set<string>();
    const boundaries: { letter: string; index: number }[] = [];
    let i = 0;
    for (const item of this.allItems) {
      const first = (this.titleFn(item) || '').charAt(0).toUpperCase();
      const letter = /[A-Z]/.test(first) ? first : '#';
      if (!letters.has(letter)) boundaries.push({ letter, index: i });
      letters.add(letter);
      i++;
    }
    this.availableLetters.set(letters);
    this.letterBoundaries = boundaries;
    if (this.scrollHandler) requestAnimationFrame(() => this.onScroll());
  }

  /** The letter of the row at the top of the scrollport, from the offset: few rows exist in the DOM. */
  private onScroll() {
    const vp = this.viewport;
    if (!vp || !this.letterBoundaries.length || performance.now() < this.letterHeldUntil) return;
    const row = Math.max(0, Math.round(vp.measureScrollOffset() / this.grid.rowHeight()));
    this.activeLetter.set(this.letterAt(row * this.grid.cols()));
  }
}
