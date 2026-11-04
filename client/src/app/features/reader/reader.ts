import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  OnDestroy,
  ViewEncapsulation,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  LucideArrowLeft,
  LucideBookmark,
  LucideCopy,
  LucideHeadphones,
  LucideListTree,
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
import { NavbarService } from '../../core/services/navbar.service';
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
import { provideCssSelectorGenerator, sandboxContentFrames } from './frame-hardening';
import { allowedExternalLink } from './link-scheme';
import { COLOUR_HEX, annotationsMarkdown, groupByChapter } from './reader-annotations';
import { ReaderAppearanceComponent } from './reader-appearance';
import { ReaderApiService, type ReaderTarget } from './reader-api.service';
import { bookMinutesLeft, chapterAt, chapterMarks, chapterMinutesLeft } from './reader-estimates';
import { provideReaderFonts } from './reader-fonts';
import { READER_KEY_BINDINGS, readerKeyAction, type ReaderKeyAction } from './reader-keys';
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

const HIDE_AFTER_MS = 3000;

const flattenToc = (links: Link[], depth = 0): TocRow[] =>
  links.flatMap((link) => [
    { link, title: link.title || link.href, depth },
    ...flattenToc(link.children?.items ?? [], depth + 1),
  ]);

const pathOf = (href: string): string => href.split('#')[0];

/** 0..1 from the progress slider, which runs 0..1000 so a book of a few hundred positions still steps finely. */
const sliderValue = (e: Event): number => Number((e.target as HTMLInputElement).value) / 1000;

const CONTEXT_CHARS = 40;
const EXCERPT_MAX = 2000;

@Component({
  selector: 'app-reader',
  imports: [
    TranslatePipe,
    ResolveUrlPipe,
    CachedSrcDirective,
    ReaderAppearanceComponent,
    ReaderSidebarComponent,
    LucideArrowLeft,
    LucideBookmark,
    LucideCopy,
    LucideHeadphones,
    LucideListTree,
    LucideNotebookPen,
    LucideSearch,
    LucideShare2,
    LucideStickyNote,
    LucideType,
  ],
  templateUrl: './reader.html',
  styleUrl: './reader.css',
  encapsulation: ViewEncapsulation.None,
  providers: [ReaderSettingsService, ReaderProgressService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:keydown)': 'onKeydown($event)',
    '(window:pagehide)': 'flushProgress()',
    '(document:visibilitychange)': 'flushProgress()',
    '(mousemove)': 'onMouseMove()',
  },
})
export class ReaderComponent implements OnDestroy {
  readonly target = input.required<ReaderTarget>();
  readonly info = input<ReaderBookInfo | null>(null);

  private readonly api = inject(ReaderApiService);
  private readonly annotationsApi = inject(AnnotationsApiService);
  private readonly audio = inject(AudioPlayerService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly navbar = inject(NavbarService);
  private readonly dismissStack = inject(DismissableStackService);
  private readonly settingsStore = inject(ReaderSettingsService);
  private readonly progress = inject(ReaderProgressService);

  private readonly pageHost = viewChild.required<ElementRef<HTMLElement>>('pageHost');
  private navigator: EpubNavigator | null = null;
  private publication: Publication | null = null;
  private positions: Locator[] = [];
  private stopSandbox: (() => void) | null = null;
  private destroyed = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private searchRun = 0;

  protected readonly settings = this.settingsStore.settings;
  protected readonly colors = computed(() => readerThemeColors(this.settings().theme));
  protected readonly title = signal('');
  protected readonly loading = signal(true);
  protected readonly chromeVisible = signal(false);
  protected readonly panel = signal<Panel | null>(null);
  protected readonly tab = signal<SidebarTab>('contents');
  protected readonly toc = signal<TocRow[]>([]);
  private readonly marks = signal<ReturnType<typeof chapterMarks>>([]);
  private readonly currentHref = signal('');
  private readonly locator = signal<Locator | null>(null);
  /** The first entry of the chapter on screen; later ones for the same file are its sections. */
  protected readonly currentRow = computed(() =>
    this.toc().findIndex((row) => pathOf(row.link.href) === this.currentHref()),
  );
  protected readonly rtl = signal(false);
  protected readonly totalProgression = signal(0);
  /** The slider's value while it is being dragged, before the jump is made. */
  protected readonly scrubbing = signal<number | null>(null);
  protected readonly shownProgression = computed(() => this.scrubbing() ?? this.totalProgression());

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
  protected readonly bubble = computed(() => {
    const at = this.scrubbing();
    const mark = at == null ? undefined : chapterAt(this.marks(), at);
    return mark?.title ?? '';
  });
  protected readonly ticks = computed(() =>
    this.marks()
      .filter((m) => m.start > 0.001)
      .map((m) => m.start),
  );
  protected readonly page = computed(() => this.locator()?.locations.position ?? 0);
  protected readonly pageTotal = signal(0);
  protected readonly chapterMinutes = computed(() => {
    const loc = this.locator();
    return loc ? chapterMinutesLeft(loc, this.positions) : 0;
  });
  protected readonly bookTime = computed(() => {
    const total = bookMinutesLeft(this.totalProgression(), this.positions);
    return { h: Math.floor(total / 60), m: total % 60 };
  });
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

  private readonly frames = new Set<Window>();
  private readonly dismissPanel = () => this.closePanel();

  constructor() {
    afterNextRender(() => void this.open());
    effect(() => {
      const prefs = toReaderPreferences(this.settings(), this.colors());
      untracked(() => void this.navigator?.submitPreferences(new EpubPreferences(prefs)));
    });
    effect(() => {
      const highlights = this.annotations().filter((a) => a.kind === 'highlight');
      untracked(() => this.paint(highlights));
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.closePanel();
    this.stopSandbox?.();
    if (this.hideTimer) clearTimeout(this.hideTimer);
    void this.progress.flush();
    void this.navigator?.destroy();
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
      this.pageTotal.set(positions.length);
      this.furthest.set(typeof saved?.progression === 'number' ? saved.progression : 0);
      this.title.set(publication.metadata.title.getTranslation() || '');
      const rows = flattenToc(publication.toc?.items ?? []);
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
      this.stopSandbox = sandboxContentFrames(container);
      const prefs = toReaderPreferences(this.settings(), this.colors());
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
          keyboardPeripherals: READER_KEY_BINDINGS,
          upgradeInsecureRequests: 'auto',
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
      textSelected: (sel) => this.onSelection(sel),
      peripheral: (e) => this.act(e.type as ReaderKeyAction),
    };
  }

  private onFrame(wnd: Window): void {
    provideCssSelectorGenerator(wnd);
    provideReaderFonts(wnd.document);
    this.frames.add(wnd);
    wnd.addEventListener('mousemove', () => this.onMouseMove(), { passive: true });
    wnd.document.addEventListener('selectionchange', () => {
      if (wnd.getSelection()?.isCollapsed) this.selection.set(null);
    });
  }

  private onPosition(locator: Locator): void {
    const total = bookProgression(locator, this.positions);
    this.totalProgression.set(total);
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
    // Enter on a focused control activates it; it only toggles the bars from the page.
    if (action === 'chrome' && target?.closest('button, a, summary')) return;
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
        break;
      case 'close':
        if (this.panel()) this.closePanel();
        else if (this.selection()) this.selection.set(null);
        else this.back();
        break;
    }
  }

  protected back(): void {
    this.navbar.goBack(['/']);
  }

  // The bars

  protected toggleChrome(): void {
    this.setChrome(!this.chromeVisible(), false);
  }

  private setChrome(visible: boolean, autoHide: boolean): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.chromeVisible.set(visible);
    if (visible && autoHide) this.hideTimer = setTimeout(() => this.hideIdle(), HIDE_AFTER_MS);
  }

  private hideIdle(): void {
    if (!this.panel() && !this.scrubbing()) this.chromeVisible.set(false);
  }

  /** A mouse that moves brings the bars up and lets them go again; a touch or a key keeps them until toggled. */
  protected onMouseMove(): void {
    if (typeof matchMedia === 'function' && !matchMedia('(hover: hover)').matches) return;
    if (this.chromeVisible() && !this.hideTimer) return;
    this.setChrome(true, true);
  }

  protected openPanel(panel: Panel, tab?: SidebarTab): void {
    if (this.panel() === panel && (!tab || this.tab() === tab)) return this.closePanel();
    if (!this.panel()) this.dismissStack.push(this.dismissPanel);
    if (tab) this.tab.set(tab);
    this.panel.set(panel);
    this.setChrome(true, false);
  }

  protected closePanel(): void {
    if (!this.panel()) return;
    this.panel.set(null);
    this.focusId.set(null);
    this.dismissStack.remove(this.dismissPanel);
  }

  // Navigation

  protected goToRow(index: number): void {
    const row = this.toc()[index];
    if (!row) return;
    this.navigator?.goLink(row.link, false, () => undefined);
    this.closePanel();
    this.setChrome(false, false);
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
    if (target) this.navigator?.go(target, false, () => undefined);
  }

  protected goToAnnotation(a: Annotation): void {
    const target = parseLocator(a.locator);
    if (target) this.navigator?.go(target, false, () => undefined);
    if (window.matchMedia('(max-width: 639px)').matches) this.closePanel();
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

  // Annotations

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
    if (!loc) return;
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
    const before =
      range && range.startContainer.nodeType === Node.TEXT_NODE
        ? (range.startContainer.textContent ?? '').slice(0, range.startOffset).slice(-CONTEXT_CHARS)
        : '';
    const after =
      range && range.endContainer.nodeType === Node.TEXT_NODE
        ? (range.endContainer.textContent ?? '').slice(
            range.endOffset,
            range.endOffset + CONTEXT_CHARS,
          )
        : '';
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
          progression: current.locations.progression ?? 0,
          position: current.locations.position ?? 0,
          totalProgression: this.totalProgression(),
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
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${
      this.title()
        .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
        .trim() || 'book'
    }.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
  }

  // Search

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
        const markup = await pub.get(link).readAsString();
        const href = pathOf(link.href);
        const chapter = this.toc().find((r) => pathOf(r.link.href) === href)?.title ?? '';
        found.push(
          ...hitsIn(
            link.href,
            chapter,
            textOfMarkup(markup ?? ''),
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
    });
    if (target) this.navigator?.go(target, false, () => undefined);
    if (window.matchMedia('(max-width: 639px)').matches) this.closePanel();
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
