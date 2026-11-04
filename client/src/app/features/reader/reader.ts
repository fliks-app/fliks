import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  input,
  OnDestroy,
  ViewEncapsulation,
  afterNextRender,
  computed,
  effect,
  inject,
  linkedSignal,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Capacitor } from '@capacitor/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  LucideArrowLeft,
  LucideBookmark,
  LucideCopy,
  LucideHeadphones,
  LucideListTree,
  LucideMaximize,
  LucideMinimize,
  LucideNotebookPen,
  LucideSearch,
  LucideShare2,
  LucideStickyNote,
  LucideType,
} from '@lucide/angular';
import {
  DecorationStyleType,
  EpubNavigator,
  EpubPreferences,
  type EpubNavigatorListeners,
} from '@readium/navigator';
import { Layout, Locator, ReadingProgression, type Link, type Publication } from '@readium/shared';
import { AudioPlayerService } from '../../core/services/audio-player/audio-player.service';
import { DismissableStackService } from '../../core/services/dismissable-stack.service';
import { safeFileName, saveFile } from '../../core/plugins/save-file.plugin';
import { ControlsVisibilityService } from '../player/controls/controls-visibility';
import { StorageScopeService } from '../../core/services/storage-scope.service';
import { Immersive } from '../../core/plugins/immersive.plugin';
import { BottomSheetComponent } from '../../shared/components/bottom-sheet';
import { IS_STANDALONE_BUNDLE } from '../../core/utils/standalone-bundle';
import { TranslatePluralPipe } from '../../core/pipes/translate-plural.pipe';
import { ToastService } from '../../core/services/toast.service';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../shared/directives/cached-src.directive';
import {
  ANNOTATION_COLOURS,
  AnnotationsApiService,
  type Annotation,
  type AnnotationColour,
} from './annotations-api.service';
import { bookProgression } from './book-progress';
import { destroyNavigator, sandboxContentFrames, selectorOf } from './frame-hardening';
import { allowedExternalLink } from './link-scheme';
import {
  COLOUR_HEX,
  annotationsMarkdown,
  blockOf,
  groupByChapter,
  rangeContext,
} from './reader-annotations';
import { ReaderAppearanceComponent } from './reader-appearance';
import { ReaderApiService, type ReaderTarget } from './reader-api.service';
import {
  bookMinutesLeft,
  chapterAt,
  chapterMarks,
  chapterMinutesLeft,
  formatMinutes,
} from './reader-estimates';
import { provideReaderFonts, readerFontsDir } from './reader-fonts';
import {
  frameWindow,
  layoutSignature,
  loadCounts,
  pageAt,
  pageCount,
  paginate,
  saveCounts,
  screensOf,
  settled,
} from './reader-pages';
import { readerKeyAction, readerKeyBindings, type ReaderKeyAction } from './reader-keys';
import { ReaderProgressService } from './reader-progress.service';
import {
  SEARCH_MAX_HITS,
  SEARCH_MIN_CHARS,
  hitsIn,
  textOfMarkup,
  type SearchHit,
} from './reader-search';
import { ReaderSidebarComponent, type SidebarTab, type TocEntry } from './reader-sidebar';
import {
  ReaderSettingsService,
  isDarkTheme,
  readerThemeColors,
  toReaderPreferences,
  type ReaderSettings,
} from './reader-settings.service';

interface TocRow {
  link: Link;
  title: string;
  depth: number;
}

/** What the work page knows and the reader shows: the author line, the cover and the audio edition to listen to. */
export interface ReaderBookInfo {
  author: string;
  coverUrl: string | null;
  listen: { itemId: number; coverUrl: string | null } | null;
}

interface PendingSelection {
  x: number;
  y: number;
  text: string;
  locator: Record<string, unknown>;
  frame: HTMLIFrameElement | null;
}

type Panel = 'appearance' | 'sidebar';

/** A new layout needs a moment before its columns are final. */
const PAGINATE_SETTLE_MS = 600;
const PHONE = '(max-width: 639px)';

const flattenToc = (links: Link[], depth = 0): TocRow[] =>
  links.flatMap((link) => [
    { link, title: link.title || link.href, depth },
    ...flattenToc(link.children?.items ?? [], depth + 1),
  ]);

const pathOf = (href: string): string => href.split('#')[0];

/** 0..1 from the progress slider, which runs 0..1000 so a book of a few hundred positions still steps finely. */
const sliderValue = (e: Event): number => Number((e.target as HTMLInputElement).value) / 1000;

const CONTEXT_CHARS = 40;
/** Three blinks of the Fliks violet, ending off. */
const FLASH_TINT = '#605dff';
const FLASH_STEPS = 6;
const FLASH_STEP_MS = 280;
const MAX_SEGMENTS = 12;
const EXCERPT_MAX = 2000;

@Component({
  selector: 'app-reader',
  imports: [
    TranslatePipe,
    TranslatePluralPipe,
    ResolveUrlPipe,
    CachedSrcDirective,
    ReaderAppearanceComponent,
    ReaderSidebarComponent,
    BottomSheetComponent,
    NgTemplateOutlet,
    LucideArrowLeft,
    LucideBookmark,
    LucideCopy,
    LucideHeadphones,
    LucideListTree,
    LucideMaximize,
    LucideMinimize,
    LucideNotebookPen,
    LucideSearch,
    LucideShare2,
    LucideStickyNote,
    LucideType,
  ],
  templateUrl: './reader.html',
  styleUrl: './reader.css',
  encapsulation: ViewEncapsulation.None,
  providers: [ReaderSettingsService, ReaderProgressService, ControlsVisibilityService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:keydown)': 'onKeydown($event)',
    '(window:pagehide)': 'flushProgress()',
    '(document:visibilitychange)': 'flushProgress()',
    '(mousemove)': 'chrome.onPointerMove()',
    '(focusin)': 'onFocusMove()',
    '(focusout)': 'onFocusMove()',
    '(document:fullscreenchange)': 'onFullscreenChange()',
  },
})
export class ReaderComponent implements OnDestroy {
  readonly target = input.required<ReaderTarget>();
  readonly closed = output<void>();
  readonly info = input<ReaderBookInfo | null>(null);

  private readonly api = inject(ReaderApiService);
  private readonly annotationsApi = inject(AnnotationsApiService);
  private readonly audio = inject(AudioPlayerService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly dismissStack = inject(DismissableStackService);
  private readonly settingsStore = inject(ReaderSettingsService);
  private readonly scope = inject(StorageScopeService);
  private readonly progress = inject(ReaderProgressService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  private readonly pageHost = viewChild.required<ElementRef<HTMLElement>>('pageHost');
  private navigator: EpubNavigator | null = null;
  private publication: Publication | null = null;
  private positions: Locator[] = [];
  private stopSandbox: (() => void) | null = null;
  private destroyed = false;
  private searchRun = 0;
  private readonly chapterText = new Map<string, string>();
  private readonly framed = new WeakSet<Window>();
  private readonly order = signal<string[]>([]);
  private readonly counts = signal<ReadonlyMap<string, number>>(new Map());
  private readonly viewport = signal<[number, number]>([0, 0]);
  /** A phone-width screen: halved margins, panels in the bottom sheet. Known before the book lays out, so it never
   *  flips mid-load: preferences pushed while the toolkit shows its first frame leave that frame unheard. */
  private readonly phoneQuery = window.matchMedia(PHONE);
  protected readonly compact = signal(this.phoneQuery.matches);
  private readonly onPhoneChange = (e: MediaQueryListEvent) => this.compact.set(e.matches);
  private readonly signature = computed(() => {
    const { theme, zoom, ...layout } = this.settings();
    return layoutSignature({ ...layout, compact: this.compact() }, ...this.viewport());
  });
  private pagesReady = false;
  private paginateRun = 0;
  private paginateTimer: ReturnType<typeof setTimeout> | null = null;
  private stopResize: (() => void) | null = null;
  private opener: HTMLElement | null = null;
  private marking = false;

  protected readonly settings = this.settingsStore.settings;
  protected readonly colors = computed(() => readerThemeColors(this.settings().theme));
  protected readonly title = signal('');
  protected readonly loading = signal(true);
  /** The player's controls countdown: shown on pointer moves and taps, held by an open panel or a drag. */
  protected readonly chrome = inject(ControlsVisibilityService);
  /** Keyboard or remote focus on a bar control keeps the bars up; hidden bars are inert and would drop it. */
  private readonly barFocused = signal(false);
  protected readonly chromeVisible = this.chrome.visible;
  protected readonly panel = signal<Panel | null>(null);
  /** The sheet keeps showing the panel it held while it slides away. */
  protected readonly sheetPanel = linkedSignal<Panel | null, Panel | null>({
    source: this.panel,
    computation: (p, prev) => p ?? prev?.value ?? null,
  });
  protected readonly tab = signal<SidebarTab>(this.settingsStore.panel().tab);
  protected readonly toc = signal<TocRow[]>([]);
  private readonly marks = signal<ReturnType<typeof chapterMarks>>([]);
  private readonly currentHref = signal('');
  private readonly locator = signal<Locator | null>(null);
  /** The first entry of the chapter on screen; later ones for the same file are its sections. */
  protected readonly currentRow = computed(() =>
    this.toc().findIndex((row) => pathOf(row.link.href) === this.currentHref()),
  );
  protected readonly rtl = signal(false);
  private flashTimer?: ReturnType<typeof setTimeout>;
  /** Bundles run fullscreen already and some browsers (iOS Safari) refuse it on a page. */
  protected readonly canFullscreen = !IS_STANDALONE_BUNDLE && document.fullscreenEnabled;
  protected readonly fullscreen = signal(!!document.fullscreenElement);
  protected readonly totalProgression = signal(0);
  /** The slider's value while it is being dragged, before the jump is made. */
  protected readonly scrubbing = signal<number | null>(null);
  /** The released value, held until the navigator reports the page it landed on. */
  private readonly landing = signal<number | null>(null);
  protected readonly shownProgression = computed(
    () => this.scrubbing() ?? this.landing() ?? this.totalProgression(),
  );

  protected readonly tocEntries = computed<TocEntry[]>(() => {
    const marks = this.marks();
    return this.toc().map((row, i) => {
      const mark =
        marks.find((m) => m.row === i) ??
        marks.find((m) => pathOf(this.toc()[m.row].link.href) === pathOf(row.link.href));
      const start = mark?.start ?? 0;
      const next = marks.find((m) => m.start > start + 1e-9);
      return { title: row.title, depth: row.depth, start, end: next?.start ?? 1 };
    });
  });
  protected readonly tocRows = computed(() =>
    this.toc().map((r) => ({ href: r.link.href, title: r.title })),
  );
  protected readonly chapterTitle = computed(() => this.toc()[this.currentRow()]?.title ?? '');
  /** The mouse position over the progress bar, previewed like a drag. */
  protected readonly hovering = signal<number | null>(null);
  protected readonly bubble = computed(() => {
    const at = this.scrubbing() ?? this.hovering();
    if (at == null) return null;
    const spot = this.positions[Math.min(this.positions.length - 1, Math.floor(at * this.positions.length))];
    return {
      at,
      title: chapterAt(this.marks(), at)?.title ?? '',
      page: spot && this.pageTotal() ? pageAt(this.order(), this.counts(), spot.href, spot.locations.progression ?? 0)?.page : undefined,
      percent: Math.round(at * 100),
    };
  });
  /** One track segment per chapter, filled up to the shown position; too many chapters make one track. */
  protected readonly segments = computed(() => {
    const starts = this.marks().map((m) => m.start).filter((s, i) => i === 0 || s > 0.001);
    const bounds = starts.length > 1 && starts.length <= MAX_SEGMENTS ? [0, ...starts.slice(1), 1] : [0, 1];
    const at = this.shownProgression();
    return bounds.slice(0, -1).map((start, i) => {
      const end = bounds[i + 1];
      return { start, width: end - start, fill: Math.min(1, Math.max(0, (at - start) / (end - start))) };
    });
  });
  /** Screen pages of the current layout; null until every chapter is laid out, or in scroll mode. */
  private readonly pageNow = computed(() => {
    const loc = this.locator();
    return loc && !this.settings().scroll ? pageAt(this.order(), this.counts(), pathOf(loc.href), loc.locations.progression ?? 0) : null;
  });
  protected readonly pageTotal = computed(() =>
    this.settings().scroll ? null : pageCount(this.order(), this.counts()),
  );
  protected readonly page = computed(() => (this.pageTotal() ? (this.pageNow()?.page ?? null) : null));
  protected readonly pagesLeft = computed(() => (this.pageTotal() ? (this.pageNow()?.left ?? null) : null));
  protected readonly chapterMinutes = computed(() => {
    const loc = this.locator();
    return loc ? chapterMinutesLeft(loc, this.positions) : 0;
  });
  protected readonly bookTime = computed(() =>
    formatMinutes(bookMinutesLeft(this.totalProgression(), this.positions)),
  );
  protected readonly percent = computed(() => Math.round(this.shownProgression() * 100));
  /** The furthest the reader has been, so read chapters stay marked after a jump back. */
  private readonly furthest = signal(0);
  protected readonly readThrough = computed(() =>
    Math.max(this.furthest(), this.totalProgression()),
  );

  protected readonly annotations = signal<Annotation[]>([]);
  protected readonly bookmarked = computed(() => {
    const loc = this.locator();
    if (!loc) return false;
    return this.annotations().some((a) => a.kind === 'bookmark' && this.sameSpot(a, loc));
  });
  protected readonly focusId = signal<number | null>(null);
  protected readonly selection = signal<PendingSelection | null>(null);
  protected readonly writing = signal(false);
  protected readonly colours = ANNOTATION_COLOURS;
  protected readonly hex = COLOUR_HEX;

  protected readonly hits = signal<SearchHit[]>([]);
  protected readonly searching = signal(false);
  protected readonly searched = signal(false);
  protected readonly searchText = signal('');

  private readonly dismissPanel = () => this.closePanel();
  private readonly sidebar = viewChild(ReaderSidebarComponent);

  constructor() {
    this.chrome.hide();
    this.phoneQuery.addEventListener('change', this.onPhoneChange);
    this.chrome.configure({
      pinned: computed(() => this.panel() !== null || this.scrubbing() !== null || this.barFocused()),
    });
    // Android system bar icons go dark over a light page; the reader's bars and the app are dark.
    if (Capacitor.isNativePlatform()) {
      effect(() => {
        const light = !isDarkTheme(this.settings().theme) && !this.chromeVisible();
        Immersive.setLightStatusBar({ light }).catch(() => {});
      });
    }
    afterNextRender(() => void this.open());
    effect(() => this.settingsStore.savePanel({ tab: this.tab() }));
    effect(() => {
      const prefs = toReaderPreferences(this.settings(), this.colors(), this.compact());
      untracked(() => void this.navigator?.submitPreferences(new EpubPreferences(prefs)));
    });
    effect(() => {
      this.signature();
      untracked(() => this.repaginate());
    });
    effect(() => {
      const highlights = this.annotations().filter((a) => a.kind === 'highlight');
      untracked(() => this.paint(highlights));
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.paginateRun++;
    if (this.paginateTimer) clearTimeout(this.paginateTimer);
    this.stopResize?.();
    this.phoneQuery.removeEventListener('change', this.onPhoneChange);
    this.closePanel();
    this.stopSandbox?.();
    void this.progress.flush();
    clearTimeout(this.flashTimer);
    if (this.navigator) void destroyNavigator(this.navigator, this.pageHost().nativeElement);
    this.api.release(this.target().itemId);
    if (document.fullscreenElement) void document.exitFullscreen();
    if (Capacitor.isNativePlatform()) Immersive.setLightStatusBar({ light: false }).catch(() => {});
  }

  private async open(): Promise<void> {
    let fixed = false;
    provideReaderFonts(document);
    try {
      const [{ publication, positions }, saved] = await Promise.all([
        this.api.open(this.target().itemId),
        this.api.loadProgress(this.target()),
      ]);
      if (this.destroyed) return;
      if (publication.metadata.effectiveLayout === Layout.fixed) {
        fixed = true;
        throw new Error('fixed layout');
      }
      this.publication = publication;
      this.positions = positions;
      this.order.set(publication.readingOrder.items.map((l) => l.href));
      this.furthest.set(typeof saved?.progression === 'number' ? saved.progression : 0);
      this.title.set(publication.metadata.title.getTranslation() || '');
      // A bare arabic number in a table of contents is a chapter number; parts carry a name.
      const rows = flattenToc(publication.toc?.items ?? []).map((r) =>
        /^\d+$/.test(r.title.trim())
          ? { ...r, title: this.translate.instant('reader.chapter_n', { n: r.title.trim() }) }
          : r,
      );
      this.toc.set(rows);
      this.marks.set(
        chapterMarks(
          rows.map((r) => ({ href: pathOf(r.link.href), title: r.title })),
          positions,
        ),
      );
      this.rtl.set(publication.metadata.effectiveReadingProgression === ReadingProgression.rtl);
      void this.loadAnnotations();
      const container = this.pageHost().nativeElement;
      const watchSize = () => this.viewport.set([Math.round(container.clientWidth), Math.round(container.clientHeight)]);
      watchSize();
      const resizeObserver = new ResizeObserver(watchSize);
      resizeObserver.observe(container);
      this.stopResize = () => resizeObserver.disconnect();
      this.stopSandbox = sandboxContentFrames(container);
      const prefs = toReaderPreferences(this.settings(), this.colors(), this.compact());
      this.navigator = new EpubNavigator(
        container,
        publication,
        // The toolkit fills in the listeners left out.
        this.listeners() as EpubNavigatorListeners,
        positions,
        parseLocator(saved?.locator),
        {
          preferences: prefs,
          defaults: {},
          keyboardPeripherals: readerKeyBindings(),
          upgradeInsecureRequests: 'auto',
          injectables: { rules: [], allowedDomains: [readerFontsDir()] },
        },
      );
      this.navigator.registerDecorationObserver('annotations', {
        onDecorationActivated: (e) => {
          this.focusId.set(Number(e.decoration.id));
          this.openPanel('sidebar', 'notes');
          return true;
        },
      });
      await this.navigator.load();
      this.paint(this.annotations().filter((a) => a.kind === 'highlight'));
      this.loading.set(false);
    } catch {
      if (this.destroyed) return;
      this.toast.error(
        this.translate.instant(fixed ? 'reader.fixed_unsupported' : 'reader.open_failed'),
      );
      this.back();
    }
  }

  private async loadAnnotations(): Promise<void> {
    try {
      const list = await this.annotationsApi.list(this.target().itemId);
      if (!this.destroyed) this.annotations.set(list);
    } catch {
      // Offline or refused: the book reads without its marks.
    }
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
        this.selection.set(null);
        if (this.panel()) this.closePanel();
        else this.toggleChrome();
      },
      click: () => this.dismissChrome(),
      tap: () => this.dismissChrome(),
      textSelected: (sel) => this.onSelection(sel),
      peripheral: (e) => this.act(e.type as ReaderKeyAction),
    };
  }

  private onFrame(wnd: Window): void {
    provideReaderFonts(wnd.document);
    if (this.framed.has(wnd)) return;
    this.framed.add(wnd);
    void settled(wnd).then(() => this.measureFrames());
    wnd.addEventListener('mousemove', () => this.chrome.onPointerMove(), { passive: true });
    wnd.document.addEventListener('selectionchange', () => {
      if (wnd.getSelection()?.isCollapsed) this.selection.set(null);
    });
  }

  /** Counting restarts from the cache on any layout change; the frames are read once the new layout has settled. */
  private repaginate(): void {
    this.paginateRun++;
    this.pagesReady = false;
    if (this.paginateTimer) clearTimeout(this.paginateTimer);
    const [w, h] = this.viewport();
    if (!this.publication || this.settings().scroll || !w) {
      this.counts.set(new Map());
      return;
    }
    this.counts.set(loadCounts(this.scope.suffix(), this.target().itemId, this.signature()));
    this.paginateTimer = setTimeout(() => void this.startPagination(), PAGINATE_SETTLE_MS);
  }

  private async startPagination(): Promise<void> {
    const publication = this.publication;
    if (!publication || this.destroyed) return;
    if (this.loading()) {
      this.paginateTimer = setTimeout(() => void this.startPagination(), PAGINATE_SETTLE_MS);
      return;
    }
    const run = this.paginateRun;
    const signature = this.signature();
    this.pagesReady = true;
    this.measureFrames();
    if (pageCount(this.order(), this.counts()) !== null) return;
    const exact = await paginate({
      host: this.pageHost().nativeElement,
      publication,
      positions: this.positions,
      prefs: toReaderPreferences(this.settings(), this.colors(), this.compact()),
      skip: (href) => this.counts().has(href),
      onCount: (href, n) => this.setCount(href, n),
      aborted: () => run !== this.paginateRun,
    }).catch(() => false);
    if (exact && run === this.paginateRun && this.scope.canPersist()) {
      saveCounts(this.scope.suffix(), this.target().itemId, signature, this.counts());
    }
  }

  private setCount(href: string, screens: number): void {
    if (this.counts().get(href) === screens) return;
    this.counts.set(new Map(this.counts()).set(href, screens));
  }

  /** The reader's own frames, the current chapter and its preloaded neighbours, are exact. */
  private measureFrames(): void {
    if (!this.pagesReady || !this.navigator) return;
    for (const href of this.order()) {
      const wnd = frameWindow(this.navigator, href);
      const n = wnd ? screensOf(wnd) : 0;
      if (n) this.setCount(href, n);
    }
  }

  private onPosition(locator: Locator): void {
    this.measureFrames();
    const total = bookProgression(locator, this.positions);
    this.totalProgression.set(total);
    this.landing.set(null);
    this.locator.set(locator);
    this.currentHref.set(pathOf(locator.href));
    this.selection.set(null);
    this.progress.report(this.target(), {
      progression: total,
      locator: locator.serialize() as Record<string, unknown>,
    });
  }

  protected onKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, select, textarea')) return;
    const action = readerKeyAction(e);
    if (!action) return;
    if ((e.key === 'Enter' || e.key === ' ') && target?.closest('button, a, summary')) return;
    // Arrows move focus in the bars and panels; they turn pages only from the book.
    if ((action === 'left' || action === 'right') && target?.closest('.rd-bar, .rd-panel')) return;
    e.preventDefault();
    this.act(action);
  }

  private act(action: ReaderKeyAction): void {
    const nav = this.navigator;
    const noop = () => undefined;
    switch (action) {
      case 'left':
        nav?.goLeft(false, noop);
        break;
      case 'right':
        nav?.goRight(false, noop);
        break;
      case 'next':
        nav?.goForward(false, noop);
        break;
      case 'prev':
        nav?.goBackward(false, noop);
        break;
      case 'start':
        if (this.positions[0]) nav?.go(this.positions[0], false, noop);
        break;
      case 'end':
        if (this.positions.length) nav?.go(this.positions[this.positions.length - 1], false, noop);
        break;
      case 'toc':
        this.openPanel('sidebar', 'contents');
        break;
      case 'notes':
        this.openPanel('sidebar', 'notes');
        break;
      case 'search':
        this.openPanel('sidebar', 'search');
        break;
      case 'bookmark':
        void this.toggleBookmark();
        break;
      case 'settings':
        this.openPanel('appearance');
        break;
      case 'chrome':
        this.toggleChrome();
        if (this.chromeVisible()) this.focusBar();
        break;
      case 'close':
        if (this.panel()) this.closePanel();
        else if (this.selection()) this.selection.set(null);
        else this.back();
        break;
    }
  }

  protected back(): void {
    this.closed.emit();
  }

  protected toggleChrome(): void {
    this.chrome.toggle();
  }

  protected onFocusMove(): void {
    queueMicrotask(() => this.barFocused.set(!!document.activeElement?.closest('.rd-bar')));
    this.chrome.onInteraction();
  }

  private setChrome(visible: boolean): void {
    if (visible) this.chrome.show();
    else this.chrome.hide();
  }

  /** Bars opened from a key put focus on their first control. */
  private focusBar(): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>('.rd-bar button')?.focus(), {
      injector: this.injector,
    });
  }

  /** The list button reopens the tab last browsed; search has its own button. */
  protected browseTab(): SidebarTab {
    return this.tab() === 'search' ? 'contents' : this.tab();
  }

  protected openPanel(panel: Panel, tab?: SidebarTab): void {
    if (this.panel() === panel && (!tab || this.tab() === tab)) return this.closePanel();
    if (!this.panel()) {
      this.dismissStack.push(this.dismissPanel);
      const active = document.activeElement;
      this.opener = active instanceof HTMLElement && active.closest('.rd-bar') ? active : null;
    }
    if (tab) this.tab.set(tab);
    this.panel.set(panel);
    this.setChrome(true);
  }

  protected closePanel(): void {
    if (!this.panel()) return;
    this.sidebar()?.flushNote();
    this.searchRun++;
    this.searching.set(false);
    this.panel.set(null);
    this.focusId.set(null);
    this.dismissStack.remove(this.dismissPanel);
    if (this.opener?.isConnected) this.opener.focus();
    this.opener = null;
  }

  protected goToRow(index: number): void {
    const row = this.toc()[index];
    if (!row) return;
    this.navigator?.goLink(row.link, false, () => undefined);
    this.closePanel();
    this.setChrome(false);
  }

  /** A click while the bars are up puts them away instead of turning the page; true when it did. */
  private dismissChrome(): boolean {
    if (this.panel() || !this.chromeVisible()) return false;
    this.selection.set(null);
    this.chrome.hide();
    return true;
  }

  /** The margins beside the text turn pages like the toolkit's side zones on the text itself. */
  protected onMarginClick(e: MouseEvent): void {
    if (e.target !== e.currentTarget || this.dismissChrome()) return;
    this.act(e.clientX < (e.currentTarget as HTMLElement).clientWidth / 2 ? 'left' : 'right');
  }

  protected onHover(e: PointerEvent): void {
    if (e.pointerType !== 'mouse') return;
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    this.hovering.set(this.rtl() ? 1 - x : x);
  }

  protected onFullscreenChange(): void {
    this.fullscreen.set(!!document.fullscreenElement);
  }

  protected toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  }

  protected onScrub(e: Event): void {
    this.scrubbing.set(sliderValue(e));
  }

  protected onSeek(e: Event): void {
    const target =
      this.positions[
        Math.min(this.positions.length - 1, Math.floor(sliderValue(e) * this.positions.length))
      ];
    this.scrubbing.set(null);
    if (!target) return;
    this.landing.set(sliderValue(e));
    this.navigator?.go(target, false, (ok) => ok || this.landing.set(null));
  }

  protected goToAnnotation(a: Annotation): void {
    this.goToPassage(parseLocator(a.locator));
  }

  /** Jumps to a quoted passage and blinks an outline around it so the eye finds it on the page. */
  private goToPassage(target: Locator | null | undefined): void {
    if (target) this.navigator?.go(target, false, (ok) => ok && this.flash(target));
    if (this.compact()) this.closePanel();
  }

  private flash(locator: Locator): void {
    const nav = this.navigator;
    if (!nav) return;
    clearTimeout(this.flashTimer);
    const on = [{ id: 'flash', locator, style: { type: DecorationStyleType.Outline, tint: FLASH_TINT } }];
    let step = 0;
    const tick = () => {
      nav.applyDecorations(step % 2 === 0 ? on : [], 'flash');
      if (++step < FLASH_STEPS) this.flashTimer = setTimeout(tick, FLASH_STEP_MS);
    };
    tick();
  }

  protected change(patch: Partial<ReaderSettings>): void {
    this.settingsStore.save(patch);
  }

  protected listen(): void {
    const listen = this.info()?.listen;
    if (!listen) return;
    void this.audio.play({
      mediaId: this.target().mediaId,
      itemId: listen.itemId,
      title: this.title(),
      artist: this.info()?.author ?? '',
      coverUrl: listen.coverUrl ?? this.info()?.coverUrl ?? null,
    });
    this.back();
  }

  private sameSpot(a: Annotation, loc: Locator): boolean {
    const at = a.locator['locations'] as { position?: number } | undefined;
    return (
      pathOf(String(a.locator['href'] ?? '')) === pathOf(loc.href) &&
      at?.position === loc.locations.position
    );
  }

  private paint(highlights: Annotation[]): void {
    const nav = this.navigator;
    if (!nav) return;
    const decorations = highlights.flatMap((a) => {
      const locator = parseLocator(a.locator);
      return locator
        ? [
            {
              id: String(a.id),
              locator,
              style: {
                type: DecorationStyleType.Highlight,
                tint: COLOUR_HEX[a.colour ?? 'yellow'],
              },
            },
          ]
        : [];
    });
    nav.applyDecorations(decorations, 'annotations');
  }

  protected async toggleBookmark(): Promise<void> {
    const loc = this.locator();
    if (!loc || this.marking) return;
    this.marking = true;
    try {
      const here = this.annotations().find((a) => a.kind === 'bookmark' && this.sameSpot(a, loc));
      if (here) {
        await this.annotationsApi.remove(here.id);
        this.annotations.update((list) => list.filter((a) => a.id !== here.id));
        return;
      }
      const created = await this.annotationsApi.create(this.target().itemId, {
        kind: 'bookmark',
        locator: loc.serialize() as Record<string, unknown>,
        excerpt: this.chapterTitle().slice(0, EXCERPT_MAX),
      });
      this.annotations.update((list) => [...list, created]);
    } catch {
      // The error interceptor has already told the reader.
    } finally {
      this.marking = false;
    }
  }

  private onSelection(sel: {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
    targetFrameSrc: string;
    locator?: Locator;
  }): void {
    const text = sel.text.trim();
    const nav = this.navigator;
    if (!text || !nav) return;
    const frame = [...this.pageHost().nativeElement.querySelectorAll('iframe')].find((f) => {
      try {
        return f.contentWindow?.location.href === sel.targetFrameSrc;
      } catch {
        return false;
      }
    });
    const rect = frame?.getBoundingClientRect();
    const range = frame?.contentWindow?.getSelection()?.rangeCount
      ? frame.contentWindow.getSelection()!.getRangeAt(0)
      : null;
    const current = nav.currentLocator;
    const { before, after, progression } = range
      ? rangeContext(range, CONTEXT_CHARS)
      : { before: '', after: '', progression: current.locations.progression ?? 0 };
    const block = range ? blockOf(range) : null;
    const cssSelector = block ? selectorOf(block) : undefined;
    this.writing.set(false);
    this.selection.set({
      x: (rect?.left ?? 0) + sel.x + sel.width / 2,
      y: (rect?.top ?? 0) + sel.y,
      text: text.slice(0, EXCERPT_MAX),
      frame: frame ?? null,
      locator: {
        href: pathOf(sel.locator?.href ?? current.href),
        type: 'application/xhtml+xml',
        title: this.chapterTitle(),
        locations: {
          progression,
          position: current.locations.position ?? 0,
          totalProgression: this.totalProgression(),
          ...(cssSelector && { cssSelector }),
        },
        text: { before, highlight: text.slice(0, EXCERPT_MAX), after },
      },
    });
  }

  protected async highlight(colour: AnnotationColour, note = ''): Promise<void> {
    const sel = this.selection();
    if (!sel) return;
    this.clearSelection();
    try {
      const created = await this.annotationsApi.create(this.target().itemId, {
        kind: 'highlight',
        colour,
        note,
        locator: sel.locator,
        excerpt: sel.text,
      });
      this.annotations.update((list) => [...list, created]);
    } catch {
      // The error interceptor has already told the reader.
    }
  }

  protected saveDraft(e: Event): void {
    const note = (e.target as HTMLFormElement).querySelector('textarea')?.value.trim() ?? '';
    void this.highlight('yellow', note);
  }

  protected async copySelection(): Promise<void> {
    const text = this.selection()?.text;
    if (!text) return;
    this.clearSelection();
    try {
      await navigator.clipboard.writeText(text);
      this.toast.success(this.translate.instant('reader.copied'));
    } catch {
      this.toast.error(this.translate.instant('reader.copy_failed'));
    }
  }

  protected async shareSelection(): Promise<void> {
    const text = this.selection()?.text;
    if (!text) return;
    const quote = `\u00AB ${text} \u00BB \u2013 ${this.title()}`.trim();
    this.clearSelection();
    try {
      if (navigator.share) await navigator.share({ text: quote });
      else {
        await navigator.clipboard.writeText(quote);
        this.toast.success(this.translate.instant('reader.copied'));
      }
    } catch {
      // A dismissed share sheet is not an error.
    }
  }

  protected searchSelection(): void {
    const text = this.selection()?.text;
    if (!text) return;
    this.clearSelection();
    this.searchText.set(text.slice(0, 80));
    this.openPanel('sidebar', 'search');
    void this.search(this.searchText());
  }

  private clearSelection(): void {
    this.selection.update((s) => {
      s?.frame?.contentWindow?.getSelection()?.removeAllRanges();
      return null;
    });
    this.writing.set(false);
  }

  protected async saveNote(change: { annotation: Annotation; note: string }): Promise<void> {
    try {
      const updated = await this.annotationsApi.update(change.annotation.id, { note: change.note });
      this.annotations.update((list) => list.map((a) => (a.id === updated.id ? updated : a)));
    } catch {
      // The error interceptor has already told the reader.
    }
  }

  protected async removeAnnotation(a: Annotation): Promise<void> {
    try {
      await this.annotationsApi.remove(a.id);
      this.annotations.update((list) => list.filter((x) => x.id !== a.id));
    } catch {
      // The error interceptor has already told the reader.
    }
  }

  protected exportMarkdown(): void {
    const labels = Object.fromEntries(
      ANNOTATION_COLOURS.map((c) => [c, this.translate.instant(`reader.colour_${c}`)]),
    ) as Record<AnnotationColour, string>;
    const groups = groupByChapter(this.annotations(), this.tocRows());
    const blob = new Blob([annotationsMarkdown(this.title(), groups, labels)], {
      type: 'text/markdown',
    });
    void saveFile(blob, `${safeFileName(this.title(), 'book')}.md`).catch(() =>
      this.toast.error(this.translate.instant('reader.export_failed')),
    );
  }

  protected async search(query: string): Promise<void> {
    const pub = this.publication;
    const run = ++this.searchRun;
    this.hits.set([]);
    this.searched.set(false);
    if (!pub || query.trim().length < SEARCH_MIN_CHARS) return;
    this.searching.set(true);
    const found: SearchHit[] = [];
    for (const link of pub.readingOrder.items) {
      if (run !== this.searchRun || this.destroyed || found.length >= SEARCH_MAX_HITS) break;
      try {
        const href = pathOf(link.href);
        let text = this.chapterText.get(href);
        if (text === undefined) {
          text = textOfMarkup(await this.api.markup(this.target().itemId, link));
          this.chapterText.set(href, text);
        }
        const chapter = this.toc().find((r) => pathOf(r.link.href) === href)?.title ?? '';
        found.push(
          ...hitsIn(
            link.href,
            chapter,
            text,
            query,
            SEARCH_MAX_HITS - found.length,
          ),
        );
        this.hits.set([...found]);
      } catch {
        // A chapter that cannot be read has no hits.
      }
    }
    if (run !== this.searchRun) return;
    this.searching.set(false);
    this.searched.set(true);
  }

  protected goToHit(hit: SearchHit): void {
    const target = parseLocator({
      href: hit.href,
      type: 'application/xhtml+xml',
      locations: { progression: hit.progression },
      text: { before: hit.before, highlight: hit.match, after: hit.after },
    });
    this.goToPassage(target);
  }

  protected flushProgress(): void {
    void this.progress.flush();
  }
}

function parseLocator(raw: unknown): Locator | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  try {
    return Locator.deserialize(raw as never);
  } catch {
    return undefined;
  }
}
