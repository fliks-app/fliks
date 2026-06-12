import { signal, ElementRef } from '@angular/core';

const DEFAULT_BATCH_SIZE = 60;

export class InfiniteScrollList<T extends { id: number }> {
  private allItems: T[] = [];
  private visibleCount = 0;
  private observer?: IntersectionObserver;
  private readonly batchSize: number;
  private titleFn: ((item: T) => string) | null = null;
  private idPrefix = '';
  private letterBoundaries: { letter: string; itemId: number }[] = [];
  private scrollHandler: (() => void) | null = null;
  private scrollRaf: number | null = null;
  private scrollLock = false;
  private scrollLockTimeout: ReturnType<typeof setTimeout> | null = null;

  /** All items (reactive — use in computed for counts/stats). */
  readonly all = signal<T[]>([]);
  readonly visible = signal<T[]>([]);
  readonly total = signal(0);
  readonly hasMore = signal(false);
  /** Letters that have at least one item. */
  readonly availableLetters = signal<Set<string>>(new Set());
  /** Currently visible letter based on scroll position. */
  readonly activeLetter = signal('');

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
    this.activeLetter.set(letter);
    this.scrollLock = true;
    if (this.scrollLockTimeout) clearTimeout(this.scrollLockTimeout);
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
      // Unlock after scroll animation settles
      const unlockOnScroll = () => {
        if (this.scrollLockTimeout) clearTimeout(this.scrollLockTimeout);
        this.scrollLockTimeout = setTimeout(() => {
          this.scrollLock = false;
          window.removeEventListener('scroll', unlockOnScroll);
        }, 150);
      };
      window.addEventListener('scroll', unlockOnScroll, { passive: true });
      // Fallback if already at position
      this.scrollLockTimeout = setTimeout(() => {
        this.scrollLock = false;
        window.removeEventListener('scroll', unlockOnScroll);
      }, 150);
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

  /** Start tracking scroll position to update activeLetter. Call once after init. */
  trackScroll(idPrefix: string) {
    this.idPrefix = idPrefix;
    // Coalesce to one active-letter lookup per frame: onScroll reads
    // getBoundingClientRect for every letter boundary (a forced layout), and
    // the TV fires scroll rapidly during its smooth D-pad scroll.
    this.scrollHandler = () => {
      if (this.scrollRaf !== null) return;
      this.scrollRaf = requestAnimationFrame(() => {
        this.scrollRaf = null;
        this.onScroll();
      });
    };
    window.addEventListener('scroll', this.scrollHandler, { passive: true });
  }

  /** Call in ngOnDestroy. */
  destroy() {
    this.observer?.disconnect();
    if (this.scrollHandler) {
      window.removeEventListener('scroll', this.scrollHandler);
    }
    if (this.scrollRaf !== null) {
      cancelAnimationFrame(this.scrollRaf);
      this.scrollRaf = null;
    }
  }

  private updateVisible() {
    this.visible.set(this.allItems.slice(0, this.visibleCount));
    this.hasMore.set(this.visibleCount < this.allItems.length);
  }

  private recomputeLetters() {
    if (!this.titleFn) return;
    const letters = new Set<string>();
    const boundaries: { letter: string; itemId: number }[] = [];
    const seen = new Set<string>();
    for (const item of this.allItems) {
      const first = (this.titleFn(item) || '').charAt(0).toUpperCase();
      const letter = /[A-Z]/.test(first) ? first : '#';
      letters.add(letter);
      if (!seen.has(letter)) {
        seen.add(letter);
        boundaries.push({ letter, itemId: item.id });
      }
    }
    this.availableLetters.set(letters);
    this.letterBoundaries = boundaries;
    if (this.idPrefix) {
      requestAnimationFrame(() => this.onScroll());
    }
  }

  private onScroll() {
    if (this.scrollLock || !this.letterBoundaries.length || !this.idPrefix) return;
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
