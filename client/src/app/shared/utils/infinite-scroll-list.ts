import { signal, ElementRef } from '@angular/core';

const DEFAULT_BATCH_SIZE = 60;

/** Live measurements of the rendered grid, supplied by the owning component
 *  when windowing is enabled. Every value lives in one coordinate space — CSS
 *  px in the document scroller — so they stay consistent even under a webOS
 *  `zoom` (read rect.top and scroller.scrollTop together). */
export interface GridMetrics {
  /** Grid top edge in document coords: rect.top + scroller.scrollTop. */
  gridTopDoc: number;
  /** One row's height: a cell's measured height plus the row gap. */
  rowHeight: number;
  /** Row gap in px (subtracted once when reserving off-window padding). */
  rowGap: number;
  /** Columns currently laid out. */
  cols: number;
}

export class InfiniteScrollList<T extends { id: number }> {
  private allItems: T[] = [];
  private visibleCount = 0;
  private observer?: IntersectionObserver;
  private readonly batchSize: number;
  private titleFn: ((item: T) => string) | null = null;
  private idPrefix = '';
  private letterBoundaries: { letter: string; itemId: number; index: number }[] = [];
  private scrollHandler: (() => void) | null = null;
  private unlockOnScroll: (() => void) | null = null;
  private scrollLock = false;
  private scrollLockTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly idIndex = new Map<number, number>();

  // Windowing — opt-in via enableWindowing(). Renders only a row-aligned slice
  // of allItems around the viewport so large lists don't pile hundreds of DOM
  // nodes onto the page. Inert (zero behavior change) unless enabled.
  private windowing = false;
  private metricsFn: (() => GridMetrics | null) | null = null;
  private bufferRows = 4;
  private windowRaf: number | null = null;
  private windowedOnce = false;
  private warnedWindowFail = false;

  /** All items (reactive — use in computed for counts/stats). */
  readonly all = signal<T[]>([]);
  readonly visible = signal<T[]>([]);
  readonly total = signal(0);
  readonly hasMore = signal(false);
  /** Letters that have at least one item. */
  readonly availableLetters = signal<Set<string>>(new Set());
  /** Currently visible letter based on scroll position. */
  readonly activeLetter = signal('');
  /** Off-window spacer heights (px). Bound to the grid's padding so the
   *  scrollbar and absolute item positions match the un-windowed layout. */
  readonly padTop = signal(0);
  readonly padBottom = signal(0);

  constructor(batchSize = DEFAULT_BATCH_SIZE) {
    this.batchSize = batchSize;
  }

  /**
   * Replace all items. Preserves the current visible window (capped to the
   * new length) — collapsing back to `batchSize` on every reload would shrink
   * the page under a user who'd scrolled past the first batch, breaking
   * scroll restoration on route reattach.
   */
  setItems(items: T[], titleFn?: (item: T) => string) {
    this.allItems = items;
    if (titleFn) this.titleFn = titleFn;
    this.all.set(items);
    this.total.set(items.length);
    this.idIndex.clear();
    for (let i = 0; i < items.length; i++) this.idIndex.set(items[i].id, i);
    this.visibleCount = Math.min(
      Math.max(this.visibleCount, this.batchSize),
      items.length,
    );
    this.updateVisible();
    this.recomputeLetters();
  }

  /** Get all items (non-reactive — use `all()` signal for computed). */
  getAll(): T[] {
    return this.allItems;
  }

  /** Index of an item id in allItems, or -1. */
  indexOf(id: number): number {
    return this.idIndex.get(id) ?? -1;
  }

  /** Load next batch. */
  showMore() {
    if (this.windowing) return;
    if (this.visibleCount >= this.allItems.length) return;
    this.visibleCount = Math.min(
      this.visibleCount + this.batchSize,
      this.allItems.length,
    );
    this.updateVisible();
  }

  // ---------------------------------------------------------------------------
  // Windowing (opt-in)
  // ---------------------------------------------------------------------------

  /** Opt in to DOM windowing: only a row-aligned slice around the viewport
   *  renders, with `bufferRows` of overscan each side so D-pad focus targets
   *  stay rendered. `metricsFn` reads the live grid. Pages that never call this
   *  keep the plain slice-0..visibleCount behavior. */
  enableWindowing(metricsFn: () => GridMetrics | null, bufferRows = 4) {
    this.windowing = true;
    this.metricsFn = metricsFn;
    this.bufferRows = bufferRows;
    this.hasMore.set(false);
    this.updateVisible();
  }

  /** Recompute the window from the current scroll position (rAF-throttled). */
  onWindowScroll() {
    if (!this.windowing || this.windowRaf !== null) return;
    this.windowRaf = requestAnimationFrame(() => {
      this.windowRaf = null;
      this.recomputeWindow();
    });
  }

  /** Synchronously ensure the row containing `index` (± buffer) is rendered. */
  ensureRendered(index: number) {
    if (!this.windowing) return;
    const m = this.metricsFn?.();
    if (!m || m.cols < 1) return;
    const row = Math.floor(index / m.cols);
    this.applyWindow(m, row - this.bufferRows, row + this.bufferRows + 1);
  }

  private recomputeWindow() {
    const m = this.metricsFn?.();
    if (!m || m.rowHeight <= 0 || m.cols < 1) {
      // Metrics not ready yet (grid not laid out) — render everything, which
      // is exactly the non-windowed behavior, so never worse than before.
      // Warn once if windowing previously succeeded then broke: that's a grid
      // CSS / measurement regression silently disabling the DOM cap, not the
      // benign first-render case.
      if (this.windowedOnce && this.allItems.length && !this.warnedWindowFail) {
        this.warnedWindowFail = true;
        console.warn(
          '[InfiniteScrollList] grid metrics unavailable after windowing succeeded — ' +
            'rendering all items. A grid layout change likely broke readGridMetrics().',
        );
      }
      this.visible.set(this.allItems.slice());
      this.padTop.set(0);
      this.padBottom.set(0);
      return;
    }
    const scrollTop = (document.scrollingElement ?? document.documentElement).scrollTop;
    const vh = window.innerHeight;
    const firstRow = Math.floor((scrollTop - m.gridTopDoc) / m.rowHeight);
    const lastRow = Math.floor((scrollTop + vh - m.gridTopDoc) / m.rowHeight);
    this.applyWindow(m, firstRow - this.bufferRows, lastRow + this.bufferRows + 1);
  }

  private applyWindow(m: GridMetrics, startRowRaw: number, endRowRaw: number) {
    this.windowedOnce = true;
    this.warnedWindowFail = false;
    const total = this.allItems.length;
    const cols = m.cols;
    const totalRows = Math.ceil(total / cols);
    let startRow = Math.max(0, Math.min(startRowRaw, totalRows));
    let endRow = Math.min(totalRows, Math.max(startRow + 1, endRowRaw));
    // Never window out the focused card's row — detaching it drops focus to
    // <body>, and the next arrow press then jumps back to the first card.
    const focusRow = this.focusedRow(cols);
    if (focusRow >= 0) {
      startRow = Math.min(startRow, focusRow);
      endRow = Math.max(endRow, focusRow + 1);
    }
    const windowStart = startRow * cols;
    const windowEnd = Math.min(total, endRow * cols);
    // Row gap sits only BETWEEN tracks, never between padding and the first/last
    // track — drop one gap from each spacer so total height matches exactly.
    this.padTop.set(startRow > 0 ? startRow * m.rowHeight - m.rowGap : 0);
    this.padBottom.set(endRow < totalRows ? (totalRows - endRow) * m.rowHeight - m.rowGap : 0);
    this.visible.set(this.allItems.slice(windowStart, windowEnd));
  }

  private focusedRow(cols: number): number {
    if (typeof document === 'undefined') return -1;
    const active = document.activeElement as HTMLElement | null;
    const el = active?.closest<HTMLElement>('[data-library-focus^="media:"]');
    const sel = el?.getAttribute('data-library-focus');
    if (!sel) return -1;
    const idx = this.idIndex.get(Number(sel.slice('media:'.length)));
    return idx == null ? -1 : Math.floor(idx / cols);
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
    this.activeLetter.set(letter);
    this.scrollLock = true;
    if (this.scrollLockTimeout) clearTimeout(this.scrollLockTimeout);

    if (this.windowing) {
      const m = this.metricsFn?.();
      if (m && m.rowHeight > 0 && m.cols >= 1) {
        // The target card may be windowed out — render it first, then scroll
        // to its computed Y (scrollIntoView would need the element to exist).
        this.ensureRendered(index);
        const targetY = Math.max(
          0,
          m.gridTopDoc + Math.floor(index / m.cols) * m.rowHeight - 96,
        );
        requestAnimationFrame(() => {
          window.scrollTo({ top: targetY, left: 0, behavior: 'smooth' });
          this.armScrollUnlock();
        });
        return;
      }
    }

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
      if (!target) {
        this.scrollLock = false;
        return;
      }
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      this.armScrollUnlock();
    });
  }

  /** Release the scroll lock once the smooth scroll settles (shared by the
   *  windowed and non-windowed scrollToLetter paths). */
  private armScrollUnlock() {
    // Re-arming clears the pending timer, so the previous closure has to be
    // dropped here or it stays bound to window with nothing left to remove it.
    if (this.unlockOnScroll) window.removeEventListener('scroll', this.unlockOnScroll);
    const release = () => {
      this.scrollLock = false;
      window.removeEventListener('scroll', unlockOnScroll);
      if (this.unlockOnScroll === unlockOnScroll) this.unlockOnScroll = null;
    };
    const unlockOnScroll = () => {
      if (this.scrollLockTimeout) clearTimeout(this.scrollLockTimeout);
      this.scrollLockTimeout = setTimeout(release, 150);
    };
    this.unlockOnScroll = unlockOnScroll;
    window.addEventListener('scroll', unlockOnScroll, { passive: true });
    // Fallback if already at position (no scroll event fires).
    this.scrollLockTimeout = setTimeout(release, 150);
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

  /** Start tracking scroll position to update activeLetter. Call once after init. */
  trackScroll(idPrefix: string) {
    this.idPrefix = idPrefix;
    if (this.scrollHandler) window.removeEventListener('scroll', this.scrollHandler);
    this.scrollHandler = () => {
      this.onWindowScroll();
      this.onScroll();
    };
    window.addEventListener('scroll', this.scrollHandler, { passive: true });
  }

  /** Call in ngOnDestroy. */
  destroy() {
    this.observer?.disconnect();
    if (this.scrollHandler) {
      window.removeEventListener('scroll', this.scrollHandler);
    }
    if (this.unlockOnScroll) {
      window.removeEventListener('scroll', this.unlockOnScroll);
      this.unlockOnScroll = null;
    }
    if (this.windowRaf !== null) {
      cancelAnimationFrame(this.windowRaf);
      this.windowRaf = null;
    }
  }

  private updateVisible() {
    if (this.windowing) {
      this.recomputeWindow();
      return;
    }
    this.visible.set(this.allItems.slice(0, this.visibleCount));
    this.hasMore.set(this.visibleCount < this.allItems.length);
  }

  private recomputeLetters() {
    if (!this.titleFn) return;
    const letters = new Set<string>();
    const boundaries: { letter: string; itemId: number; index: number }[] = [];
    const seen = new Set<string>();
    let i = 0;
    for (const item of this.allItems) {
      const first = (this.titleFn(item) || '').charAt(0).toUpperCase();
      const letter = /[A-Z]/.test(first) ? first : '#';
      letters.add(letter);
      if (!seen.has(letter)) {
        seen.add(letter);
        boundaries.push({ letter, itemId: item.id, index: i });
      }
      i++;
    }
    this.availableLetters.set(letters);
    this.letterBoundaries = boundaries;
    if (this.idPrefix) {
      requestAnimationFrame(() => this.onScroll());
    }
  }

  private onScroll() {
    if (this.scrollLock || !this.letterBoundaries.length || !this.idPrefix) return;
    if (this.windowing) {
      // Position math — no getElementById, which would miss windowed-out
      // boundary cards (and skips the per-scroll forced layout entirely).
      const m = this.metricsFn?.();
      if (!m || m.rowHeight <= 0 || m.cols < 1) return;
      const scrollTop = (document.scrollingElement ?? document.documentElement).scrollTop;
      const topRow = Math.max(0, Math.floor((scrollTop + 96 - m.gridTopDoc) / m.rowHeight));
      const topIndex = topRow * m.cols;
      let current = this.letterBoundaries[0].letter;
      for (const b of this.letterBoundaries) {
        if (b.index <= topIndex) current = b.letter;
        else break;
      }
      this.activeLetter.set(current);
      return;
    }
    let current = this.letterBoundaries[0].letter;
    for (const { letter, itemId } of this.letterBoundaries) {
      const el = document.getElementById(`${this.idPrefix}-${itemId}`);
      if (!el) continue;
      if (el.getBoundingClientRect().top > 100) break;
      current = letter;
    }
    this.activeLetter.set(current);
  }
}
