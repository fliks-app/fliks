import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { StorageScopeService } from '../../../../core/services/storage-scope.service';
import { ReaderSession } from '../../reader-session';
import { toReaderPreferences } from '../../reader-settings.service';
import { EpubBook, pathOf } from './epub-book';
import {
  frameWindow,
  layoutSignature,
  loadCounts,
  pageAt,
  pageCount,
  paginate,
  saveCounts,
  screensOf,
} from './reader-pages';

/** A new layout needs a moment before its columns are final. */
const PAGINATE_SETTLE_MS = 600;

/** Screen pages of the current layout: counted once per layout signature in the background, cached per book. */
@Injectable()
export class EpubPagination {
  private readonly book = inject(EpubBook);
  private readonly session = inject(ReaderSession);
  private readonly scope = inject(StorageScopeService);

  private readonly order = signal<string[]>([]);
  private readonly counts = signal<ReadonlyMap<string, number>>(new Map());
  readonly viewport = signal<[number, number]>([0, 0]);
  private readonly signature = computed(() => {
    const { theme, zoom, ...layout } = this.session.settings();
    return layoutSignature({ ...layout, compact: this.session.compact() }, ...this.viewport());
  });
  private ready = false;
  private run = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** A fixed-layout book has no scroll mode. */
  private readonly scroll = computed(() => this.session.settings().scroll && !this.book.fixed);
  /** The screen on view; null until every chapter is laid out, or in scroll mode. */
  private readonly now = computed(() => {
    const loc = this.book.locator();
    return loc && !this.scroll()
      ? pageAt(this.order(), this.counts(), pathOf(loc.href), loc.locations.progression ?? 0)
      : null;
  });
  readonly total = computed(() => (this.scroll() ? null : pageCount(this.order(), this.counts())));
  readonly page = computed(() => (this.total() ? (this.now()?.page ?? null) : null));
  readonly left = computed(() => (this.total() ? (this.now()?.left ?? null) : null));

  constructor() {
    effect(() => {
      this.signature();
      untracked(() => this.restart());
    });
    inject(DestroyRef).onDestroy(() => {
      this.run++;
      if (this.timer) clearTimeout(this.timer);
    });
  }

  setOrder(hrefs: string[]): void {
    this.order.set(hrefs);
    this.restart();
  }

  /** The page a book position falls on, for the progress bar's preview. */
  pageOf(href: string, progression: number): number | undefined {
    return this.total() ? pageAt(this.order(), this.counts(), href, progression)?.page : undefined;
  }

  /** Counting restarts from the cache on any layout change; the frames are read once the new layout has settled. */
  private restart(): void {
    this.run++;
    this.ready = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.book.fixed) {
      this.counts.set(new Map(this.order().map((href) => [href, 1])));
      return;
    }
    const [w] = this.viewport();
    if (!this.book.publication || this.session.settings().scroll || !w) {
      this.counts.set(new Map());
      return;
    }
    this.counts.set(loadCounts(this.scope.suffix(), this.session.target().itemId, this.signature()));
    this.timer = setTimeout(() => void this.start(), PAGINATE_SETTLE_MS);
  }

  private async start(): Promise<void> {
    const { publication, host } = this.book;
    if (!publication || !host || this.book.destroyed) return;
    if (!this.book.ready()) {
      this.timer = setTimeout(() => void this.start(), PAGINATE_SETTLE_MS);
      return;
    }
    const run = this.run;
    const signature = this.signature();
    this.ready = true;
    this.measure();
    if (pageCount(this.order(), this.counts()) !== null) return;
    const settings = this.session.settings();
    const exact = await paginate({
      host,
      publication,
      positions: this.book.positions,
      prefs: toReaderPreferences(settings, this.session.colors(), this.session.compact()),
      skip: (href) => this.counts().has(href),
      onCount: (href, n) => this.setCount(href, n),
      aborted: () => run !== this.run,
    }).catch(() => false);
    if (exact && run === this.run && this.scope.canPersist()) {
      saveCounts(this.scope.suffix(), this.session.target().itemId, signature, this.counts());
    }
  }

  private setCount(href: string, screens: number): void {
    if (this.counts().get(href) === screens) return;
    this.counts.set(new Map(this.counts()).set(href, screens));
  }

  /** The reader's own frames, the current chapter and its preloaded neighbours, are exact. */
  measure(): void {
    const nav = this.book.navigator;
    if (!this.ready || !nav) return;
    for (const href of this.order()) {
      const wnd = frameWindow(nav, href);
      const n = wnd ? screensOf(wnd) : 0;
      if (n) this.setCount(href, n);
    }
  }
}
