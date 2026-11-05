import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewEncapsulation,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { EpubNavigator, EpubPreferences, type EpubNavigatorListeners } from '@readium/navigator';
import { Layout, ReadingProgression, type Locator } from '@readium/shared';
import { ToastService } from '../../../../core/services/toast.service';
import { ReaderApiService, type ReaderTarget } from '../../reader-api.service';
import type { ReaderEngine, ReaderStatus, ReaderToc, ScrubPreview } from '../../reader-engine';
import { readerKeyBindings, type ReaderKeyAction } from '../../reader-keys';
import { ReaderProgressService } from '../../reader-progress.service';
import { ReaderSession } from '../../reader-session';
import { toReaderPreferences } from '../../reader-settings.service';
import type { TocEntry } from '../../reader-sidebar';
import { bookProgression } from './book-progress';
import { EpubBook, flattenToc, parseLocator, pathOf } from './epub-book';
import { EpubNotes } from './epub-notes';
import { EpubPagination } from './epub-pagination';
import { EpubSearch } from './epub-search';
import { EpubSelectionComponent, type FrameSelection } from './epub-selection';
import { destroyNavigator, provideFrameSelectors } from './frame-hardening';
import { allowedExternalLink } from './link-scheme';
import { bookMinutesLeft, chapterAt, chapterMinutesLeft, formatMinutes } from './reader-estimates';
import { provideReaderFonts, readerFontsDir } from './reader-fonts';
import { settled } from './reader-pages';

/** More chapters than this make one track. */
const MAX_SEGMENTS = 12;
/** Stops of the progress bar, so a book of a few hundred positions still steps finely. */
const STEPS = 1001;

/** A reflowable EPUB, laid out by the Readium toolkit in frames under the reader's bars. */
@Component({
  selector: 'app-epub-engine',
  imports: [EpubSelectionComponent],
  templateUrl: './epub-engine.html',
  styleUrl: './epub-engine.css',
  encapsulation: ViewEncapsulation.None,
  providers: [EpubBook, EpubPagination, EpubNotes, EpubSearch],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EpubEngineComponent implements ReaderEngine, OnDestroy {
  readonly target = input.required<ReaderTarget>();

  private readonly api = inject(ReaderApiService);
  private readonly session = inject(ReaderSession);
  private readonly progress = inject(ReaderProgressService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly book = inject(EpubBook);
  private readonly pages = inject(EpubPagination);
  readonly notes = inject(EpubNotes);
  readonly search = inject(EpubSearch);

  private readonly pageHost = viewChild.required<ElementRef<HTMLElement>>('pageHost');
  private readonly selectionBar = viewChild.required(EpubSelectionComponent);
  private readonly framed = new WeakSet<Window>();
  private stopSelectors: (() => void) | null = null;
  private stopResize: (() => void) | null = null;

  readonly loading = computed(() => !this.book.ready());
  readonly rtl = signal(false);
  /** The released position, held until the navigator reports the page it landed on. */
  private readonly landing = signal<number | null>(null);
  readonly progression = computed(() => this.landing() ?? this.book.totalProgression());
  readonly steps = signal(STEPS);
  /** One track segment per chapter. */
  readonly segments = computed(() => {
    const starts = this.book.marks().map((m) => m.start).filter((s, i) => i === 0 || s > 0.001);
    return starts.length > 1 && starts.length <= MAX_SEGMENTS ? [0, ...starts.slice(1)] : [0];
  });
  readonly status = computed<ReaderStatus>(() => {
    const loc = this.book.locator();
    const left = this.pages.left();
    return {
      section: this.book.chapterTitle(),
      sectionLeft: left !== null ? { pages: left } : { minutes: loc ? chapterMinutesLeft(loc, this.book.positions) : 0 },
      page: this.pages.page(),
      pages: this.pages.total(),
      bookLeft: formatMinutes(bookMinutesLeft(this.book.totalProgression(), this.book.positions)),
    };
  });

  /** The furthest the reader has been, so read chapters stay marked after a jump back. */
  private readonly furthest = signal(0);
  readonly toc: ReaderToc = {
    entries: computed<TocEntry[]>(() => {
      const marks = this.book.marks();
      const rows = this.book.toc();
      return rows.map((row, i) => {
        const mark =
          marks.find((m) => m.row === i) ?? marks.find((m) => pathOf(rows[m.row].link.href) === pathOf(row.link.href));
        const start = mark?.start ?? 0;
        const next = marks.find((m) => m.start > start + 1e-9);
        return { title: row.title, depth: row.depth, start, end: next?.start ?? 1 };
      });
    }),
    rows: this.book.tocRows,
    current: this.book.currentRow,
    readThrough: computed(() => Math.max(this.furthest(), this.book.totalProgression())),
    go: (index) => this.goToRow(index),
  };

  constructor() {
    this.session.attach(this);
    afterNextRender(() => void this.open());
    effect(() => {
      const prefs = toReaderPreferences(this.session.settings(), this.session.colors(), this.session.compact());
      untracked(() => void this.book.navigator?.submitPreferences(new EpubPreferences(prefs)));
    });
  }

  ngOnDestroy(): void {
    this.book.dispose();
    this.stopResize?.();
    this.stopSelectors?.();
    if (this.book.navigator) void destroyNavigator(this.book.navigator, this.pageHost().nativeElement);
    this.api.release(this.target().itemId);
  }

  private async open(): Promise<void> {
    let fixed = false;
    provideReaderFonts(document);
    try {
      const [{ publication, positions }, saved] = await Promise.all([
        this.api.open(this.target().itemId),
        this.api.loadProgress(this.target()),
      ]);
      if (this.book.destroyed) return;
      if (publication.metadata.effectiveLayout === Layout.fixed) {
        fixed = true;
        throw new Error('fixed layout');
      }
      const container = this.pageHost().nativeElement;
      this.book.publication = publication;
      this.book.positions = positions;
      this.book.host = container;
      this.furthest.set(typeof saved?.progression === 'number' ? saved.progression : 0);
      // A bare arabic number in a table of contents is a chapter number; parts carry a name.
      this.book.setToc(
        flattenToc(publication.toc?.items ?? []).map((r) =>
          /^\d+$/.test(r.title.trim()) ? { ...r, title: this.translate.instant('reader.chapter_n', { n: r.title.trim() }) } : r,
        ),
      );
      this.rtl.set(publication.metadata.effectiveReadingProgression === ReadingProgression.rtl);
      this.pages.setOrder(publication.readingOrder.items.map((l) => l.href));
      void this.notes.load();
      this.watchSize(container);
      this.stopSelectors = provideFrameSelectors(container);
      const nav = new EpubNavigator(
        container,
        publication,
        // The toolkit fills in the listeners left out.
        this.listeners() as EpubNavigatorListeners,
        positions,
        parseLocator(saved?.locator),
        {
          preferences: toReaderPreferences(this.session.settings(), this.session.colors(), this.session.compact()),
          defaults: {},
          keyboardPeripherals: readerKeyBindings(),
          upgradeInsecureRequests: 'auto',
          injectables: { rules: [], allowedDomains: [readerFontsDir()] },
        },
      );
      this.book.navigator = nav;
      nav.registerDecorationObserver('annotations', {
        onDecorationActivated: (e) => {
          this.notes.focusId.set(Number(e.decoration.id));
          this.session.openPanel('sidebar', 'notes');
          return true;
        },
      });
      await nav.load();
      this.notes.paint();
      this.book.ready.set(true);
    } catch {
      if (this.book.destroyed) return;
      this.toast.error(this.translate.instant(fixed ? 'reader.fixed_unsupported' : 'reader.open_failed'));
      this.session.close();
    }
  }

  private watchSize(container: HTMLElement): void {
    const size = () => this.pages.viewport.set([Math.round(container.clientWidth), Math.round(container.clientHeight)]);
    size();
    const observer = new ResizeObserver(size);
    observer.observe(container);
    this.stopResize = () => observer.disconnect();
  }

  private listeners(): Partial<EpubNavigatorListeners> {
    return {
      frameLoaded: (wnd) => this.onFrame(wnd),
      positionChanged: (locator) => this.onPosition(locator),
      handleLocator: (locator) => {
        const url = allowedExternalLink(locator.href);
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
        return true;
      },
      miscPointer: () => {
        this.selectionBar().dismiss();
        if (this.session.panel()) this.session.closePanel();
        else this.session.toggleChrome();
      },
      click: () => this.dismissChrome(),
      tap: () => this.dismissChrome(),
      textSelected: (sel) => this.selectionBar().show(sel as FrameSelection),
      peripheral: (e) => this.session.act(e.type as ReaderKeyAction),
    };
  }

  private dismissChrome(): boolean {
    if (!this.session.dismissChrome()) return false;
    this.selectionBar().dismiss();
    return true;
  }

  private onFrame(wnd: Window): void {
    provideReaderFonts(wnd.document);
    if (this.framed.has(wnd)) return;
    this.framed.add(wnd);
    void settled(wnd).then(() => this.pages.measure());
    wnd.addEventListener('mousemove', () => this.session.onPointerMove(), { passive: true });
    wnd.document.addEventListener('selectionchange', () => {
      if (wnd.getSelection()?.isCollapsed) this.selectionBar().dismiss();
    });
  }

  private onPosition(locator: Locator): void {
    this.pages.measure();
    const total = bookProgression(locator, this.book.positions);
    this.book.totalProgression.set(total);
    this.landing.set(null);
    this.book.locator.set(locator);
    this.selectionBar().dismiss();
    this.progress.report(this.target(), { progression: total, locator: locator.serialize() as Record<string, unknown> });
  }

  /** The margins beside the text turn pages like the toolkit's side zones on the text itself. */
  protected onMarginClick(e: MouseEvent): void {
    if (e.target !== e.currentTarget || this.dismissChrome()) return;
    this.act(e.clientX < (e.currentTarget as HTMLElement).clientWidth / 2 ? 'left' : 'right');
  }

  act(action: ReaderKeyAction): boolean {
    const nav = this.book.navigator;
    const positions = this.book.positions;
    const noop = () => undefined;
    switch (action) {
      case 'left':
        nav?.goLeft(false, noop);
        return true;
      case 'right':
        nav?.goRight(false, noop);
        return true;
      case 'next':
        nav?.goForward(false, noop);
        return true;
      case 'prev':
        nav?.goBackward(false, noop);
        return true;
      case 'start':
        if (positions[0]) nav?.go(positions[0], false, noop);
        return true;
      case 'end':
        if (positions.length) nav?.go(positions[positions.length - 1], false, noop);
        return true;
      case 'close':
        if (!this.selectionBar().active) return false;
        this.selectionBar().dismiss();
        return true;
      default:
        return false;
    }
  }

  private positionAt(at: number): Locator | undefined {
    const positions = this.book.positions;
    return positions[Math.min(positions.length - 1, Math.floor(at * positions.length))];
  }

  seek(at: number): void {
    const target = this.positionAt(at);
    if (!target) return;
    this.landing.set(at);
    this.book.navigator?.go(target, false, (ok) => ok || this.landing.set(null));
  }

  preview(at: number): ScrubPreview {
    const spot = this.positionAt(at);
    return {
      section: chapterAt(this.book.marks(), at)?.title ?? '',
      page: spot ? (this.pages.pageOf(spot.href, spot.locations.progression ?? 0) ?? null) : null,
    };
  }

  private goToRow(index: number): void {
    const row = this.book.toc()[index];
    if (!row) return;
    this.book.navigator?.goLink(row.link, false, () => undefined);
    this.session.closePanel();
    this.session.hideChrome();
  }
}
