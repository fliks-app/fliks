import {
  Component,
  signal,
  computed,
  inject,
  Injector,
  OnInit,
  OnDestroy,
  ElementRef,
  ViewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { MediaService, Media, GenreSummary, CollectionSummary } from '../../core/services/api/media.service';
import {
  SocialApiService,
  ReceivedRecommendation,
} from '../../core/services/api/social-api.service';
import { LikesApiService, LikedItem } from '../../core/services/api/likes-api.service';
import { StreamingApiService } from '../../core/services/api/streaming-api.service';
import { OfflinePlaybackSyncService } from '../../core/services/offline-playback-sync.service';
import { ProfilesService, QualityProfile } from '../../core/services/api/profiles.service';
import { LibrariesApiService, LibrarySummary } from '../../core/services/api/libraries-api.service';
import { MediaCardComponent } from '../../shared/components/media-card/media-card';
import { DropdownMenuComponent } from '../../shared/components/dropdown-menu';
import { TvSelectDirective } from '../../shared/directives/tv-select.directive';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';
import type {
  ContinueWatchingItem,
  RecommendationItem,
} from '../../core/services/api/streaming-api.service';
import { PageScrollerService } from '../../core/services/page-scroller.service';
import { PageScrollModeService } from '../../core/services/page-scroll-mode.service';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { BackgroundService } from '../../core/services/background.service';
import { DisplaySettingsService } from '../../core/services/display-settings.service';
import { DefaultFocusDirective } from '../../shared/directives/default-focus.directive';
import { TvRowDirective } from '../../shared/directives/tv-row.directive';
import { NavbarService } from '../../core/services/navbar.service';
import { keepRouteFresh } from '../../core/services/keep-route-fresh';
import { InfiniteScrollList } from '../../shared/utils/infinite-scroll-list';
import { LucideSearch, LucideSlidersHorizontal, LucideArrowUp, LucideArrowDown, LucideX, LucideFilm } from '@lucide/angular';
import { MosaicCardComponent } from '../../shared/components/mosaic-card/mosaic-card';
import { CardSkeletonComponent } from '../../shared/components/card-skeleton';
import { ImportProgressBannerComponent } from '../../shared/components/import-progress-banner/import-progress-banner';
import { NgTemplateOutlet } from '@angular/common';
import { fanartPool, itemArtwork } from '../../shared/utils/media-artwork.util';
import { PlayableMediaService } from '../../core/services/playable-media.service';
import {
  CdkVirtualScrollViewport,
  CdkFixedSizeVirtualScroll,
  CdkVirtualForOf,
  CdkVirtualScrollableElement,
  CdkVirtualScrollableWindow,
} from '@angular/cdk/scrolling';

const ALPHABET = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** Top-bar tab — `all` is the existing library grid (label = library name),
 *  `suggestions` / `genres` are placeholders for upcoming views. */
export type LibraryViewMode = 'all' | 'suggestions' | 'genres' | 'collections' | 'likes';
export type SortOrder = 'ASC' | 'DESC';
type FilterMonitored = '' | 'true' | 'false';
type FilterWatched = '' | 'watched' | 'unwatched';

/** Natural default order per sort field. Title reads A→Z; the three
 *  date / rating fields lead with the most recent / best value because
 *  that's what users actually want to see first. Applied whenever the
 *  user switches `sortBy` — they can still flip with the ↑/↓ button. */
const NATURAL_ORDER_BY_SORT: Record<string, SortOrder> = {
  title: 'ASC',
  year: 'DESC',
  added: 'DESC',
  rating: 'DESC',
};

@Component({
  selector: 'app-library',
  imports: [
    MediaCardComponent,
    DefaultFocusDirective,
    TvRowDirective,
    DropdownMenuComponent,
    TvSelectDirective,
    HorizontalScrollerComponent,
    FormsModule,
    TranslatePipe,
    LucideSearch,
    LucideSlidersHorizontal,
    LucideArrowUp,
    LucideArrowDown,
    LucideFilm,
    LucideX,
    MosaicCardComponent,
    NgTemplateOutlet,
    CdkVirtualScrollViewport,
    CdkFixedSizeVirtualScroll,
    CdkVirtualForOf,
    CdkVirtualScrollableElement,
    CdkVirtualScrollableWindow,
    CardSkeletonComponent,
    ImportProgressBannerComponent,
  ],
  templateUrl: './library.html',
})
export class LibraryComponent implements OnInit, OnDestroy {
  private readonly mediaService = inject(MediaService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly offlineSync = inject(OfflinePlaybackSyncService);
  private readonly playableMedia = inject(PlayableMediaService);
  private readonly socialApi = inject(SocialApiService);
  private readonly likesApi = inject(LikesApiService);
  private readonly profilesService = inject(ProfilesService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly pageScroller = inject(PageScrollerService);
  private readonly scrollMode = inject(PageScrollModeService);
  private readonly scrollMemory = inject(ScrollMemoryService);
  private readonly injector = inject(Injector);
  private readonly background = inject(BackgroundService);
  private readonly displaySettings = inject(DisplaySettingsService);
  readonly navbar = inject(NavbarService);
  private readonly translate = inject(TranslateService);
  protected readonly itemArtwork = itemArtwork;
  private paramSub?: Subscription;
  /** TV and desktop scroll the window instead (`PageScrollModeService`); every
   *  mode-dependent branch below reads this rather than the platform itself. */
  readonly windowScroll = computed(() => this.scrollMode.mode() === 'window');
  /** Per-library scroll-memory key, in both modes: ScrollMemoryService saves
   *  and restores whichever scroller the page claimed. */
  private scrollMemoryKey(): string | null {
    const name = this.libraryName();
    return name ? `library-${name}` : null;
  }
  /** Cached per library name: revalidate the grid on return, re-claim the
   *  scroller and restore its saved offset. */
  private readonly routeFresh = keepRouteFresh({
    refresh: () => this.refreshCurrentView(),
    scrollKey: () => this.scrollMemoryKey(),
    onAttach: () => {
      const lib = this.library();
      if (lib) this.navbar.setPageTitle(lib.name);
      // Synchronously, so the shared restore that follows writes this shell
      // and not the document.
      if (!this.windowScroll()) this.pageScroller.claim(this.shellRef.nativeElement);
      if (!this.navbar.navigatedBack()) this.enterAtTop();
      else {
        // The letter survives the trip in this component; the restore's own
        // scroll event must not recompute it off the row it lands on.
        this.holdLetter();
        this.renderRangeForRememberedOffset();
      }
      this.applyBackground();
    },
    onDetach: () => {
      if (!this.windowScroll()) this.pageScroller.release(this.shellRef.nativeElement);
    },
  });

  /** Same fanart backdrop as the home page, from this library's own titles, so
   *  the topbar keeps its frosted look here too — but only to fill a gap.
   *  Opening a library from the home page keeps the image already showing; it is
   *  coming back from a detail page, which clears the background on its way out,
   *  that leaves nothing behind to look at. */
  private applyBackground(): void {
    if (this.background.url()) return;
    this.background.applyPool(
      fanartPool(this.list.all()),
      this.displaySettings.settings().homeBackground,
    );
  }
  private queryParamSub?: Subscription;
  /** Set while a state-driven `syncQueryParams` is being applied to the
   *  URL, so the `queryParamMap` subscription that fires right after
   *  can ignore the round-trip instead of re-applying our own write. */
  private skipQueryParamSync = false;

  /** Resolved library (null while loading or if not found). */
  readonly library = signal<LibrarySummary | null>(null);
  readonly libraryName = signal('');

  readonly list = new InfiniteScrollList<Media>();
  readonly watchedIds = signal<Set<number>>(new Set());
  readonly loading = signal(true);
  readonly searchQuery = signal('');
  readonly sortBy = signal('title');
  readonly sortOrder = signal<SortOrder>('ASC');
  readonly filterMonitored = signal<FilterMonitored>('');
  readonly filterStatus = signal('');
  readonly filterWatched = signal<FilterWatched>('');
  readonly viewMode = signal<LibraryViewMode>('all');

  // ── Suggestions view ────────────────────────────────────────────────
  /** Continue-watching items, scoped to the active library. */
  private readonly suggestionsContinueRaw = signal<ContinueWatchingItem[]>([]);
  /** Server list with any position queued while offline layered on top — the
   *  API keeps returning the pre-offline progress until the queue flushes. */
  readonly suggestionsContinue = computed(() =>
    this.offlineSync.overlayProgress(this.suggestionsContinueRaw()),
  );
  /** History-based recommendations, scoped to the active library. */
  readonly suggestionsRecommendations = signal<RecommendationItem[]>([]);
  /** Popular among the members the user follows. */
  readonly suggestionsFromFollowing = signal<RecommendationItem[]>([]);
  /** Content other members have recommended to the viewer. */
  readonly recommendedForYou = signal<ReceivedRecommendation[]>([]);
  readonly suggestionsLoading = signal(true);
  /**
   * A revalidation must not blank a panel that already has content: the tab is
   * replaced by its skeleton, which drops whatever the viewer was looking at,
   * including the card a back transition is morphing into.
   */
  private readonly hasSuggestions = computed(
    () =>
      this.suggestionsContinueRaw().length > 0 ||
      this.suggestionsRecommendations().length > 0 ||
      this.suggestionsFromFollowing().length > 0 ||
      this.recommendedForYou().length > 0,
  );

  // ── Genres view ─────────────────────────────────────────────────────
  /** Distinct genres in the library + sample posters for the mosaic. */
  readonly genresList = signal<GenreSummary[]>([]);
  readonly genresLoading = signal(true);
  /** When set, the `all` grid is filtered to this genre via the API's
   *  `genre=` param. Cleared with the chip's × button. */
  readonly selectedGenre = signal<string>('');

  // ── Collections view ────────────────────────────────────────────────
  readonly collectionsList = signal<CollectionSummary[]>([]);
  readonly collectionsLoading = signal(true);
  readonly selectedCollectionId = signal<number | null>(null);

  // ── Likes view ──────────────────────────────────────────────────────
  /** The viewer's liked content scoped to the active library. */
  readonly likesList = signal<LikedItem[]>([]);
  readonly likesLoading = signal(true);

  readonly monitoredCount = computed(() => this.list.all().filter((m) => m.monitored).length);
  readonly movieFileCount = computed(() =>
    this.list.all().filter((m) => m.type === 'movie' && (m.files?.length ?? 0) > 0).length,
  );
  readonly totalMovies = computed(() =>
    this.list.all().filter((m) => m.type === 'movie').length,
  );
  readonly totalSeries = computed(() =>
    this.list.all().filter((m) => m.type === 'series').length,
  );
  readonly totalEpisodes = computed(() =>
    this.list.all().reduce((sum, m) => sum + (m.episodeStats?.totalEpisodes ?? 0), 0),
  );
  readonly downloadedEpisodes = computed(() =>
    this.list.all().reduce((sum, m) => sum + (m.episodeStats?.downloadedEpisodes ?? 0), 0),
  );
  readonly hasMovies = computed(() => this.totalMovies() > 0);
  readonly hasSeries = computed(() => this.totalSeries() > 0);

  readonly alphabet = ALPHABET;
  readonly hasActiveFilters = computed(() =>
    this.filterMonitored() !== '' ||
    this.filterStatus() !== '' ||
    this.filterWatched() !== '',
  );

  @ViewChild('sentinel') set sentinelRef(ref: ElementRef<HTMLElement> | undefined) {
    this.list.observeSentinel(ref);
  }

  /** The page's scroll container in every view mode, so the claim and the
   *  scroll listener follow its lifetime, not the CDK viewport's. */
  @ViewChild('shell', { static: true }) private shellRef!: ElementRef<HTMLElement>;

  /** The `all`-view card grid — measured for DOM windowing on TV. */
  private onResize?: () => void;

  /** Placeholder counts for the tab skeletons: a screenful for a grid, a row
   *  for a horizontal scroller. */
  protected readonly skeletonCards = Array.from({ length: 24 }, (_, i) => i);
  protected readonly skeletonRow = Array.from({ length: 6 }, (_, i) => i);

  // ── CDK virtual scroll ───────────────────────────────────────────────────
  // The grid renders through `cdk-virtual-scroll-viewport` on every platform:
  // only the rows on screen exist, and the views scrolled past are recycled.
  /** Columns and row pitch, measured from the first laid-out row. The initial
   *  values only have to be plausible — the viewport re-lays out as soon as the
   *  real ones land. The row carries the vertical gap as bottom padding, so its
   *  measured height IS the pitch; deriving it from height + row-gap instead
   *  drifted and collapsed the space between rows. */
  readonly gridCols = signal(6);
  readonly rowHeight = signal(520);
  /** All items chunked into rows — the viewport scrolls rows, not cards. */
  readonly gridRows = computed(() => {
    const cols = this.gridCols();
    const items = this.list.all();
    const rows: { index: number; items: Media[] }[] = [];
    for (let i = 0; i < items.length; i += cols) {
      rows.push({ index: rows.length, items: items.slice(i, i + cols) });
    }
    return rows;
  });
  protected trackRow(_: number, row: { index: number }): number {
    return row.index;
  }
  /** Alphabet highlight. Derived from the scroll offset, not from the DOM
   *  (only a handful of rows exist) and not from `scrolledIndexChange`, which
   *  stays at 0 when the viewport scrolls the window rather than itself. */
  private letterRaf: number | null = null;
  /** How long a deliberate jump outranks the scroll-driven recompute: the row
   *  it lands on usually opens with the tail of the previous letter. */
  private static readonly LETTER_HOLD_MS = 600;
  private letterHeldUntil = 0;
  private readonly onLetterScroll = () => {
    if (this.letterRaf !== null) return;
    this.letterRaf = requestAnimationFrame(() => {
      this.letterRaf = null;
      this.syncActiveLetter();
    });
  };
  /** The index tracks the row at the top of the scrollport, so it has to be
   *  derived once the grid exists and not only when the offset changes. */
  private syncActiveLetter(): void {
    if (!this.viewport || performance.now() < this.letterHeldUntil) return;
    const row = Math.max(0, Math.round(this.viewport.measureScrollOffset() / this.rowHeight()));
    this.list.activeLetter.set(this.list.letterAt(row * this.gridCols()));
  }
  /** Recreated whenever the `@if` block toggles (tab switch, loading state), so
   *  only what genuinely needs a viewport belongs here. */
  @ViewChild(CdkVirtualScrollViewport) private set viewportRef(ref: CdkVirtualScrollViewport | undefined) {
    this.viewport = ref;
    if (!ref) return;
    // Bounding comes from route data (already applied by the time this
    // component exists), but the CDK viewport still needs a tick to see it.
    queueMicrotask(() => {
      ref.checkViewportSize();
      this.syncActiveLetter();
    });
  }
  /** Where the rows start inside whatever scrolls, since a scroll offset is
   *  measured from the scroller's top. In window mode that IS the document. */
  private rowsOffset(): number {
    const vp = this.viewport?.elementRef.nativeElement;
    if (!vp) return 0;
    const shell = this.shellRef.nativeElement;
    return this.windowScroll()
      ? vp.getBoundingClientRect().top + window.scrollY
      : vp.getBoundingClientRect().top - shell.getBoundingClientRect().top + shell.scrollTop;
  }
  /** The rows an offset lands on, rendered now: CDK would only get there on the
   *  next change detection, too late for a poster morph or the default focus. */
  private renderRangeForOffset(offset: number): void {
    const vp = this.viewport;
    if (!vp) return;
    const range = vp.getRenderedRange();
    const span = Math.max(1, range.end - range.start);
    const rows = this.gridRows().length;
    const first = Math.max(0, Math.min(
      Math.floor(Math.max(0, offset - this.rowsOffset()) / this.rowHeight()),
      Math.max(0, rows - span),
    ));
    // Only when it has moved: re-rendering a range recycles its views, and a
    // poster morph pairs with the very DOM node the click stamped. A page that
    // owns its scroller comes back with both its offset and its range intact.
    if (first >= range.start && first < range.end) return;
    vp.setRenderedRange({ start: first, end: first + span });
    vp.setRenderedContentOffset(first * this.rowHeight());
  }
  /** The offset lives in the shared memory, whose sticky restore lands after
   *  this: range from the value it is about to write. */
  private renderRangeForRememberedOffset(): void {
    const key = this.scrollMemoryKey();
    const offset = key ? this.scrollMemory.remembered(key) : undefined;
    if (offset) this.renderRangeForOffset(offset);
  }
  private enterAtTop(): void {
    this.renderRangeForOffset(0);
    this.list.activeLetter.set(this.list.letterAt(0));
    this.scrollOwnTo(0);
  }
  /** Own element, not the ambient claim, so a write never reaches whichever
   *  page is on screen; instant because TV scrolls the shell smoothly. */
  private scrollOwnTo(top: number): void {
    if (this.windowScroll()) {
      window.scrollTo({ top, left: 0, behavior: 'instant' });
      return;
    }
    this.shellRef.nativeElement.scrollTo({ top, left: 0, behavior: 'instant' });
  }
  private holdLetter(): void {
    this.letterHeldUntil = performance.now() + LibraryComponent.LETTER_HOLD_MS;
  }
  private viewport?: CdkVirtualScrollViewport;
  private cardRowEl?: HTMLElement;
  /** Measured once per layout. The strategy is fixed-size: it places every row
   *  at `index * itemSize`, so re-measuring a row whose natural height moved by
   *  a pixel makes the pitch disagree with the placement, and the error
   *  accumulates — a jump thousands of rows down lands a whole section early. */
  private rowMeasured = false;
  @ViewChild('cardRow') set cardRowRef(ref: ElementRef<HTMLElement> | undefined) {
    this.cardRowEl = ref?.nativeElement;
    this.measureRow();
  }
  private measureRow(force = false): void {
    const row = this.cardRowEl;
    if (!row || (this.rowMeasured && !force)) return;
    const cs = getComputedStyle(row);
    const cols = cs.gridTemplateColumns.split(' ').filter((t) => t && t !== '0px').length;
    const gap = parseFloat(cs.rowGap) || 0;
    // Height of the cards themselves: the row is pinned to `rowHeight` below,
    // so measure a child, not the row.
    const cell = row.firstElementChild?.getBoundingClientRect().height ?? 0;
    if (cols < 1 || cell <= 0) return;
    this.rowMeasured = true;
    this.gridCols.set(cols);
    this.rowHeight.set(cell + gap);
  }

  // Bulk editing
  readonly selectedIds = signal<Set<number>>(new Set());
  readonly bulkMode = signal(false);
  readonly bulkSaving = signal(false);
  readonly bulkQualityProfileId = signal<number | null>(null);
  readonly bulkMonitored = signal<FilterMonitored>('');
  readonly qualityProfiles = signal<QualityProfile[]>([]);

  private allLibraries: LibrarySummary[] = [];
  /** Bumped on every `load()` so a stale background revalidation kicked off
   *  for the previous library can't overwrite the current view. */
  private loadGen = 0;

  ngOnInit() {
    const shell = this.shellRef.nativeElement;
    if (this.windowScroll()) {
      window.addEventListener('scroll', this.onLetterScroll, { passive: true });
    } else {
      this.pageScroller.claim(shell);
      shell.addEventListener('scroll', this.onLetterScroll, { passive: true });
    }
    // A resize can change the column count, which re-chunks the rows.
    this.onResize = () => {
      this.rowMeasured = false;
      this.measureRow(true);
    };
    window.addEventListener('resize', this.onResize, { passive: true });
    // Subscribe to route param changes (handles initial load + sidebar nav).
    this.paramSub = this.route.params.subscribe(async (params) => {
      const rawName = params['libraryName'] as string;
      if (!rawName) return;
      const name = decodeURIComponent(rawName);
      this.libraryName.set(name);

      // Resolve library by name
      if (!this.allLibraries.length) {
        this.allLibraries = await this.librariesApi.listMine();
      }

      // Resolve the /movies and /series sentinels (__default_movies__ / __default_series__)
      if (name === '__default_movies__' || name === '__default_series__') {
        const flag = name === '__default_movies__' ? 'isDefaultForMovies' : 'isDefaultForSeries';
        const defaultLib = this.allLibraries.find((l) => l[flag]) ?? this.allLibraries[0];
        if (defaultLib) {
          void this.router.navigate(
            ['/libraries', encodeURIComponent(defaultLib.name)],
            { replaceUrl: true },
          );
        }
        return;
      }

      const lib = this.allLibraries.find((l) => l.name === name);
      this.library.set(lib ?? null);
      if (!lib) {
        this.stopLoading();
        return;
      }

      this.navbar.setPageTitle(lib.name);
      // A fresh instance (never cached, or evicted from the reuse cache) has
      // no attach$ event to trigger keepRouteFresh's own restoreSticky.
      const scrollKey = this.scrollMemoryKey();
      if (scrollKey) this.scrollMemory.activate(scrollKey);

      // Restore filters
      const qp = this.route.snapshot.queryParamMap;
      const stored = this.loadFilters(lib.name);
      this.searchQuery.set(qp.get('q') ?? stored['q'] ?? '');
      this.filterMonitored.set(
        (qp.get('monitored') ?? stored['monitored'] ?? '') as FilterMonitored,
      );
      this.filterStatus.set(qp.get('status') ?? stored['status'] ?? '');
      this.filterWatched.set(
        (qp.get('watched') ?? stored['watched'] ?? '') as FilterWatched,
      );
      this.sortBy.set(qp.get('sortBy') ?? stored['sortBy'] ?? 'title');
      this.sortOrder.set(
        (qp.get('sortOrder') ?? stored['sortOrder'] ?? 'ASC') as SortOrder,
      );
      // View / genre / collection are navigation state, read only from the URL
      // (within-session back/forward, deep links) — never from the persisted
      // filters — so opening a library fresh lands on the `all` tab.
      this.viewMode.set((qp.get('view') ?? 'all') as LibraryViewMode);
      this.selectedGenre.set(qp.get('genre') ?? '');
      const collId = qp.get('collectionId');
      this.selectedCollectionId.set(collId ? Number(collId) : null);

      this.syncQueryParams();
      await this.load(lib.id);
      if (scrollKey) this.scrollMemory.restore(scrollKey, this.injector);
      void this.loadLikes();
      if (this.viewMode() === 'suggestions') {
        // Either a deep-link with `?view=suggestions` or a return from
        // back-nav with the persisted mode. Fetch the suggestions data
        // alongside the regular grid so the panel isn't empty.
        void this.loadSuggestions();
      } else if (this.viewMode() === 'genres') {
        void this.loadGenres();
      } else if (this.viewMode() === 'collections') {
        void this.loadCollections();
      } else if (this.viewMode() === 'likes') {
        void this.loadLikes();
      }
    });

    // Re-apply state on browser back/forward (same route, queryParams
    // change). Initial load + state-driven `syncQueryParams` writes are
    // skipped via the `skipQueryParamSync` flag so we don't recurse.
    this.queryParamSub = this.route.queryParamMap.subscribe((qp) => {
      if (this.skipQueryParamSync) {
        this.skipQueryParamSync = false;
        return;
      }
      if (!this.library()) return;
      this.searchQuery.set(qp.get('q') ?? '');
      this.filterMonitored.set((qp.get('monitored') ?? '') as FilterMonitored);
      this.filterStatus.set(qp.get('status') ?? '');
      this.filterWatched.set((qp.get('watched') ?? '') as FilterWatched);
      this.sortBy.set(qp.get('sortBy') ?? 'title');
      this.sortOrder.set((qp.get('sortOrder') ?? 'ASC') as SortOrder);
      this.viewMode.set((qp.get('view') ?? 'all') as LibraryViewMode);
      this.selectedGenre.set(qp.get('genre') ?? '');
      const collId = qp.get('collectionId');
      this.selectedCollectionId.set(collId ? Number(collId) : null);
      const lib = this.library();
      if (lib) {
        // `silent` only suppresses the spinner, so the swap still needs the reset.
        this.scrollOwnTo(0);
        void this.load(lib.id, true);
        void this.loadLikes();
        if (this.viewMode() === 'genres') void this.loadGenres();
        else if (this.viewMode() === 'collections') void this.loadCollections();
        else if (this.viewMode() === 'suggestions') void this.loadSuggestions();
      }
    });
  }

  /** Bring the visible library up to date: the grid always, plus whichever tab
   *  is on screen so its SWR cache gets a chance to bring in fresh data. */
  private refreshCurrentView(): void {
    const lib = this.library();
    if (!lib) return;
    void this.load(lib.id, true);
    void this.loadLikes();
    if (this.viewMode() === 'suggestions') void this.loadSuggestions();
    else if (this.viewMode() === 'genres') void this.loadGenres();
  }

  ngOnDestroy() {
    this.list.destroy();
    if (this.onResize) window.removeEventListener('resize', this.onResize);
    this.scrollMemory.deactivate();
    if (this.windowScroll()) {
      window.removeEventListener('scroll', this.onLetterScroll);
    } else {
      this.shellRef.nativeElement.removeEventListener('scroll', this.onLetterScroll);
      this.pageScroller.release(this.shellRef.nativeElement);
    }
    if (this.letterRaf !== null) cancelAnimationFrame(this.letterRaf);
    this.navbar.clearPageTitle();
    this.paramSub?.unsubscribe();

    this.queryParamSub?.unsubscribe();
  }

  scrollToLetter(letter: string) {
    if (this.viewport) {
      const index = this.list.getAll().findIndex((item) => {
        const first = (item.title || '').charAt(0).toUpperCase();
        return letter === '#' ? !/[A-Z]/.test(first) : first === letter;
      });
      if (index < 0) return;
      this.list.activeLetter.set(letter);
      this.holdLetter();
      const row = Math.floor(index / this.gridCols());
      const shell = this.shellRef.nativeElement;
      const chrome = this.windowScroll() ? 0 : parseFloat(getComputedStyle(shell).paddingTop) || 0;
      // Instant: the rows in between are not rendered, so an animated jump
      // would spend its whole duration crossing blank space.
      this.viewport.scrollToOffset(
        Math.max(0, row * this.rowHeight() + this.rowsOffset() - chrome),
        'instant',
      );
      return;
    }
    this.list.scrollToLetter(letter, (m) => m.title, 'media');
  }

  /** Live measurements of the `all` grid for windowing. Read together (rect +
   *  scroller.scrollTop) so a webOS `zoom` scales them consistently. Returns
   *  null until the grid is laid out, where windowing falls back to full render. */
  onSearch(query: string) {
    this.searchQuery.set(query);
    this.syncQueryParams();
    this.load(this.library()?.id);
  }

  onFilterChange() {
    this.syncQueryParams();
    this.load(this.library()?.id);
  }

  toggleSortOrder() {
    this.sortOrder.update((o) => (o === 'ASC' ? 'DESC' : 'ASC'));
    this.onFilterChange();
  }

  onSortByChange(field: string) {
    this.sortBy.set(field);
    // Snap to the field's natural order so the leading items are the
    // ones the user typically wants (newest / best first). The arrow
    // button still lets them flip after the fact.
    this.sortOrder.set(NATURAL_ORDER_BY_SORT[field] ?? 'ASC');
    this.onFilterChange();
  }

  setViewMode(mode: LibraryViewMode) {
    if (this.viewMode() === mode) return;
    this.viewMode.set(mode);
    this.scrollOwnTo(0);
    // Tab switches stay on the same history entry — back from the
    // library should return to the previous page, not walk through
    // every tab the user clicked.
    this.syncQueryParams(false);
    if (mode === 'suggestions') {
      void this.loadSuggestions();
    } else if (mode === 'genres') {
      void this.loadGenres();
    } else if (mode === 'collections') {
      void this.loadCollections();
    } else if (mode === 'likes') {
      void this.loadLikes();
    }
  }

  /** Click handler on a genre card — set the genre filter and pivot
   *  back to the main `all` grid where it's actually applied. */
  pickGenre(genre: string) {
    this.selectedGenre.set(genre);
    this.viewMode.set('all');
    this.syncQueryParams(false);
    void this.load(this.library()?.id);
  }

  clearSelectedGenre() {
    this.selectedGenre.set('');
    this.syncQueryParams();
    void this.load(this.library()?.id);
  }

  pickCollection(id: number) {
    this.selectedCollectionId.set(id);
    this.viewMode.set('all');
    this.syncQueryParams(false);
    void this.load(this.library()?.id);
  }

  clearSelectedCollection() {
    this.selectedCollectionId.set(null);
    this.syncQueryParams();
    void this.load(this.library()?.id);
  }

  private async loadCollections(): Promise<void> {
    const lib = this.library();
    if (!lib) return;
    if (!this.collectionsList().length) this.collectionsLoading.set(true);
    try {
      const rows = await this.mediaService.getCollections(lib.id).catch(() => null);
      if (rows) this.collectionsList.set(rows);
    } finally {
      this.collectionsLoading.set(false);
    }
  }

  /** Route to a liked / recommended item: the episode page when it targets an
   *  episode, otherwise the movie or series detail page. */
  contentLink(
    mediaType: string,
    mediaId: number,
    episodeId: number | null,
  ): string[] {
    if (episodeId) {
      return ['/series', String(mediaId), 'episode', String(episodeId)];
    }
    return [mediaType === 'series' ? '/series' : '/movies', String(mediaId)];
  }

  async playContinueWatching(item: ContinueWatchingItem) {
    await this.playableMedia.resume(item);
  }

  /** Fetches the viewer's liked content scoped to the active library. */
  private async loadLikes(): Promise<void> {
    const lib = this.library();
    if (!lib) return;
    if (!this.likesList().length) this.likesLoading.set(true);
    try {
      const rows = await this.likesApi.mine(lib.id, { force: true }).catch(() => null);
      if (rows) this.likesList.set(rows);
    } finally {
      this.likesLoading.set(false);
    }
  }

  /** Fetches the genres aggregate (count + sample posters) for the
   *  current library. Same SWR pattern as `loadSuggestions`. */
  private async loadGenres(): Promise<void> {
    const lib = this.library();
    if (!lib) return;
    if (!this.genresList().length) this.genresLoading.set(true);
    try {
      const rows = await this.mediaService.getGenres(lib.id).catch(() => null);
      if (rows) this.genresList.set(rows);
    } finally {
      this.genresLoading.set(false);
    }
  }

  /** Fetches continue-watching + recommendations for the active library.
   *  No in-memory dedup — the HTTP cache (stale-while-revalidate) handles
   *  the no-op case when the entry is fresh, and we want every `attached$`
   *  re-visit to give the SWR a chance to pull in updated data. Signals
   *  keep their previous value until each response lands, so flipping
   *  between tabs never blanks the panel. */
  private async loadSuggestions(): Promise<void> {
    const lib = this.library();
    if (!lib) return;
    if (!this.hasSuggestions()) this.suggestionsLoading.set(true);
    try {
      const [cw, recs, following, forYou] = await Promise.all([
        this.streamingApi.getContinueWatching(lib.id).catch(() => null),
        this.streamingApi
          .getRecommendations({ libraryId: lib.id, limit: 30 })
          .catch(() => null),
        this.socialApi.followingRecommendations(lib.id).catch(() => null),
        this.socialApi.receivedRecommendations().catch(() => null),
      ]);
      if (cw) this.suggestionsContinueRaw.set(cw);
      if (recs) this.suggestionsRecommendations.set(recs);
      if (following) this.suggestionsFromFollowing.set(following);
      if (forYou) this.recommendedForYou.set(forYou);
    } finally {
      this.suggestionsLoading.set(false);
    }
  }

  toggleSelect(id: number) {
    this.selectedIds.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // Lazy-load quality profiles on first selection (for bulk edit panel).
    if (!this.qualityProfiles().length) {
      this.profilesService.getQualityProfiles().then((p) => this.qualityProfiles.set(p)).catch(() => {});
    }
  }

  selectAll() {
    this.selectedIds.set(new Set(this.list.all().map((m) => m.id)));
  }

  deselectAll() {
    this.selectedIds.set(new Set());
  }

  toggleBulkMode() {
    this.bulkMode.update((v) => !v);
    if (!this.bulkMode()) {
      this.selectedIds.set(new Set());
      this.bulkQualityProfileId.set(null);
      this.bulkMonitored.set('');
    }
  }

  async applyBulk() {
    const ids = [...this.selectedIds()];
    if (!ids.length) return;

    const body: Parameters<MediaService['bulkUpdate']>[0] = { ids };
    if (this.bulkQualityProfileId() !== null) {
      body.qualityProfileId = this.bulkQualityProfileId()!;
    }
    if (this.bulkMonitored() !== '') {
      body.monitored = this.bulkMonitored() === 'true';
    }

    this.bulkSaving.set(true);
    try {
      await this.mediaService.bulkUpdate(body);
      this.selectedIds.set(new Set());
      this.bulkQualityProfileId.set(null);
      this.bulkMonitored.set('');
      this.bulkMode.set(false);
      await this.load(this.library()?.id);
    } finally {
      this.bulkSaving.set(false);
    }
  }

  /** Filter/sort *preferences* persisted to localStorage and restored when a
   *  library is opened fresh. Deliberately excludes the active tab and its
   *  in-tab selection (view / genre / collection): those are navigation state,
   *  not preferences, so reopening the app lands on the library root rather
   *  than the tab the user happened to leave open. */
  private buildStoredParams(): Record<string, string> {
    const p: Record<string, string> = {};
    if (this.searchQuery()) p['q'] = this.searchQuery();
    if (this.filterMonitored()) p['monitored'] = this.filterMonitored();
    if (this.filterStatus()) p['status'] = this.filterStatus();
    if (this.filterWatched()) p['watched'] = this.filterWatched();
    if (this.sortBy() !== 'title') p['sortBy'] = this.sortBy();
    if (this.sortOrder() !== 'ASC') p['sortOrder'] = this.sortOrder();
    return p;
  }

  /** The full state mirrored into the URL — the persisted preferences plus the
   *  active tab and its selection — so within-session back/forward and deep
   *  links restore the exact view. */
  private buildUrlParams(): Record<string, string> {
    const p = this.buildStoredParams();
    if (this.viewMode() !== 'all') p['view'] = this.viewMode();
    if (this.selectedGenre()) p['genre'] = this.selectedGenre();
    if (this.selectedCollectionId()) p['collectionId'] = String(this.selectedCollectionId());
    return p;
  }

  /** Reflect the current state in the URL. `push` adds a real history entry
   *  instead of replacing — used for the genres-list → genre-filter transition
   *  so the browser back button returns to the Genres list. */
  private syncQueryParams(push = false) {
    this.skipQueryParamSync = true;
    void this.router.navigate([], { queryParams: this.buildUrlParams(), replaceUrl: !push });
    this.saveFilters();
  }

  private get storageKey(): string {
    return `fliks.filters.library.${this.libraryName()}`;
  }

  private saveFilters() {
    localStorage.setItem(this.storageKey, JSON.stringify(this.buildStoredParams()));
  }

  private loadFilters(name: string): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem(`fliks.filters.library.${name}`) ?? '{}');
    } catch {
      return {};
    }
  }

  /** Drop every tab out of its initial loading state — for the dead ends where
   *  no fetch will follow, which would otherwise leave a skeleton up for good. */
  private stopLoading() {
    this.loading.set(false);
    this.suggestionsLoading.set(false);
    this.genresLoading.set(false);
    this.collectionsLoading.set(false);
    this.likesLoading.set(false);
  }

  private async load(libraryId?: number, silent = false) {
    // Filters, search and sort all reflow the header above the grid.
    if (!libraryId) {
      if (!silent) this.loading.set(false);
      return;
    }
    if (!silent) {
      this.loading.set(true);
      // The scroller keeps its offset across a content swap, which a filter
      // that returns a screenful would leave parked in blank space.
      this.scrollOwnTo(0);
    }
    const monitored = this.filterMonitored();
    const fs = this.filterStatus();
    const fw = this.filterWatched();
    const params = {
      libraryId,
      q: this.searchQuery() || undefined,
      sortBy: this.sortBy(),
      sortOrder: this.sortOrder(),
      genre: this.selectedGenre() || undefined,
      collectionId: this.selectedCollectionId() ?? undefined,
      monitored: monitored ? monitored === 'true' : undefined,
      missing: fs === 'missing' ? true : fs === 'downloaded' ? false : undefined,
      cutoffUnmet: fs === 'cutoffUnmet' ? true : undefined,
      onlyWatched: fw === 'watched' ? true : undefined,
      excludeWatched: fw === 'unwatched' ? true : undefined,
      limit: 0,
    } as const;
    const gen = ++this.loadGen;
    try {
      const [res, watchedIds] = await Promise.all([
        this.mediaService.getAll(params),
        this.streamingApi.getWatchedMediaIds().catch(() => [] as number[]),
      ]);
      this.list.setItems(res.data, (m) => m.title);
      this.applyBackground();
      this.watchedIds.set(new Set(watchedIds));
    } finally {
      if (!silent) this.loading.set(false);
    }
    queueMicrotask(() => {
      // Cached lists paint instantly; revalidate so a media imported / files
      // landed / watched-toggled since the last visit shows up without
      // waiting on the 5 min TTL. Generation check drops a stale background
      // result when the user has already moved to another library.
      if (gen !== this.loadGen) return;
      void Promise.all([
        this.mediaService.getAll(params, { force: true }).catch(() => null),
        this.streamingApi.getWatchedMediaIds({ force: true }).catch(() => null),
      ]).then(([res, watchedIds]) => {
        if (gen !== this.loadGen) return;
        if (res) {
          this.list.setItems(res.data, (m) => m.title);
          this.applyBackground();
        }
        if (watchedIds) this.watchedIds.set(new Set(watchedIds));
      });
    });
  }

  /** Series always toggleable (bulk endpoint, no file needed). Movies need
   *  at least one local file — without it `toggleWatched` has nothing to
   *  reference and the action would silently no-op. */
  canMarkMediaWatched(m: Media): boolean {
    return m.type === 'series' || !!m.files?.length;
  }

  isLiked(mediaId: number): boolean {
    return this.likesList().some((l) => l.mediaId === mediaId && !l.seasonId && !l.episodeId);
  }

  async toggleLike(m: Media, liked: boolean) {
    try {
      await (liked ? this.likesApi.like({ mediaId: m.id }) : this.likesApi.unlike({ mediaId: m.id }));
      await this.loadLikes();
    } catch { /* interceptor surfaces errors */ }
  }

  async toggleMediaWatched(m: Media, watched: boolean) {
    try {
      if (m.type === 'series') {
        await this.streamingApi.toggleSeriesWatched(m.id, watched);
      } else {
        const fileId = m.files?.[0]?.id;
        if (!fileId) return;
        await this.streamingApi.toggleWatched(m.id, fileId);
      }
      // Reflect new state on the visible card without a full refetch —
      // the parent's `watchedIds` set drives the `'watched'` status badge.
      this.watchedIds.update((set) => {
        const next = new Set(set);
        if (watched) next.add(m.id);
        else next.delete(m.id);
        return next;
      });
    } catch { /* global error toast */ }
  }
}
