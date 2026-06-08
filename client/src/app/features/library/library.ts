import {
  Component,
  ChangeDetectionStrategy,
  signal,
  computed,
  inject,
  Injector,
  OnInit,
  OnDestroy,
  ElementRef,
  ViewChild,
  afterNextRender,
  effect,
} from '@angular/core';
import { ActivatedRoute, NavigationStart, Router } from '@angular/router';
import { Subscription, filter } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MediaService, Media, GenreSummary, CollectionSummary } from '../../core/services/api/media.service';
import { StreamingApiService } from '../../core/services/api/streaming-api.service';
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
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { FocusMemoryService } from '../../core/services/focus-memory.service';
import { NavbarService } from '../../core/services/navbar.service';
import { TvService } from '../../core/services/tv.service';
import { CachingReuseStrategy } from '../../core/services/route-reuse.strategy';
import { AppResumeService } from '../../core/services/app-resume.service';
import { InfiniteScrollList } from '../../shared/utils/infinite-scroll-list';
import { LucideSearch, LucideSlidersHorizontal, LucideArrowUp, LucideArrowDown, LucideX, LucideFilm } from '@lucide/angular';
import { MosaicCardComponent } from '../../shared/components/mosaic-card/mosaic-card';

const ALPHABET = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** Top-bar tab — `all` is the existing library grid (label = library name),
 *  `suggestions` / `genres` are placeholders for upcoming views. */
export type LibraryViewMode = 'all' | 'suggestions' | 'genres' | 'collections';
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
    DropdownMenuComponent,
    TvSelectDirective,
    HorizontalScrollerComponent,
    FormsModule,
    TranslateModule,
    LucideSearch,
    LucideSlidersHorizontal,
    LucideArrowUp,
    LucideArrowDown,
    LucideFilm,
    LucideX,
    MosaicCardComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './library.html',
})
export class LibraryComponent implements OnInit, OnDestroy {
  private readonly mediaService = inject(MediaService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly profilesService = inject(ProfilesService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly scrollMemory = inject(ScrollMemoryService);
  private readonly focusMemory = inject(FocusMemoryService);
  readonly navbar = inject(NavbarService);
  private readonly tv = inject(TvService);
  private readonly injector = inject(Injector);
  private readonly translate = inject(TranslateService);
  private readonly reuseStrategy = inject(CachingReuseStrategy);
  private readonly appResume = inject(AppResumeService);
  private arrivedViaBack = false;
  private navStartSub?: Subscription;
  private attachedSub?: Subscription;
  private detachedSub?: Subscription;
  private queryParamSub?: Subscription;
  private resumeSub?: Subscription;
  /** True while this cached instance is detached (some other route is shown).
   *  Gates the app-resume refresh so only the visible library refetches. */
  private detached = false;
  /** Set while a state-driven `syncQueryParams` is being applied to the
   *  URL, so the `queryParamMap` subscription that fires right after
   *  can ignore the round-trip instead of re-applying our own write. */
  private skipQueryParamSync = false;

  /** Resolved library (null while loading or if not found). */
  readonly library = signal<LibrarySummary | null>(null);
  readonly libraryName = signal('');

  readonly list = new InfiniteScrollList<Media>();
  readonly watchedIds = signal<Set<number>>(new Set());
  readonly loading = signal(false);
  readonly searchQuery = signal('');
  readonly sortBy = signal('title');
  readonly sortOrder = signal<SortOrder>('ASC');
  readonly filterMonitored = signal<FilterMonitored>('');
  readonly filterStatus = signal('');
  readonly filterWatched = signal<FilterWatched>('');
  readonly viewMode = signal<LibraryViewMode>('all');

  // ── Suggestions view ────────────────────────────────────────────────
  /** Continue-watching items, scoped to the active library. */
  readonly suggestionsContinue = signal<ContinueWatchingItem[]>([]);
  /** History-based recommendations, scoped to the active library. */
  readonly suggestionsRecommendations = signal<RecommendationItem[]>([]);
  readonly suggestionsLoading = signal(false);

  // ── Genres view ─────────────────────────────────────────────────────
  /** Distinct genres in the library + sample posters for the mosaic. */
  readonly genresList = signal<GenreSummary[]>([]);
  readonly genresLoading = signal(false);
  /** When set, the `all` grid is filtered to this genre via the API's
   *  `genre=` param. Cleared with the chip's × button. */
  readonly selectedGenre = signal<string>('');

  // ── Collections view ────────────────────────────────────────────────
  readonly collectionsList = signal<CollectionSummary[]>([]);
  readonly collectionsLoading = signal(false);
  readonly selectedCollectionId = signal<number | null>(null);

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

  /** Re-load when route param changes (e.g. clicking another library in sidebar). */
  private readonly paramEffect = effect(() => {
    // Angular signal-based route params aren't available yet in 21.x for
    // lazy routes, so we subscribe manually in ngOnInit below.
  }, { allowSignalWrites: true });

  ngOnInit() {
    this.arrivedViaBack = this.navbar.lastWasBack();
    if (this.tv.isTv()) {
      this.navStartSub = this.router.events
        .pipe(filter((e): e is NavigationStart => e instanceof NavigationStart))
        .subscribe(() => {
          const active = document.activeElement as HTMLElement | null;
          const container = active?.closest<HTMLElement>('[data-library-focus]');
          const sel = container?.dataset['libraryFocus'];
          const lib = this.library();
          if (sel && lib) this.focusMemory.save(`library-${lib.id}`, sel);
        });
    }
    // Subscribe to route param changes (handles initial load + sidebar nav).
    this.route.params.subscribe(async (params) => {
      const rawName = params['libraryName'] as string;
      if (!rawName) return;
      const name = decodeURIComponent(rawName);
      this.libraryName.set(name);

      // Resolve library by name
      if (!this.allLibraries.length) {
        this.allLibraries = await this.librariesApi.listMine();
      }

      // Handle legacy redirects (__default_movies__ / __default_series__)
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
      if (!lib) return;

      this.navbar.setPageTitle(lib.name);

      // Restore filters
      const scrollKey = `library-${lib.id}`;
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
      this.viewMode.set(
        (qp.get('view') ?? stored['view'] ?? 'all') as LibraryViewMode,
      );
      this.selectedGenre.set(qp.get('genre') ?? stored['genre'] ?? '');
      const storedColl = qp.get('collectionId') ?? stored['collectionId'];
      this.selectedCollectionId.set(storedColl ? Number(storedColl) : null);

      this.scrollMemory.activate(scrollKey);
      this.list.trackScroll('media');
      this.syncQueryParams();
      await this.load(lib.id);
      if (this.viewMode() === 'suggestions') {
        // Either a deep-link with `?view=suggestions` or a return from
        // back-nav with the persisted mode. Fetch the suggestions data
        // alongside the regular grid so the panel isn't empty.
        void this.loadSuggestions();
      } else if (this.viewMode() === 'genres') {
        void this.loadGenres();
      } else if (this.viewMode() === 'collections') {
        void this.loadCollections();
      }
      this.scrollMemory.restore(scrollKey, this.injector);
      if (this.tv.isTv()) {
        afterNextRender(() => this.applyDefaultFocus(lib.id), { injector: this.injector });
      }
    });

    // Each /libraries/:libraryName has its own cache slot (CachingReuseStrategy
    // keys per param). On return, ngOnInit doesn't re-fire — refresh data,
    // re-claim scroll/focus, and rebind the navbar title via attached$.
    const ownKey = this.reuseStrategy.keyFor(this.route.snapshot);
    this.attachedSub = this.reuseStrategy.attached$.subscribe((key) => {
      if (key !== ownKey) return;
      this.detached = false;
      const lib = this.library();
      if (!lib) return;
      const scrollKey = `library-${lib.id}`;
      this.scrollMemory.activate(scrollKey);
      this.navbar.setPageTitle(lib.name);
      void this.load(lib.id, true);
      // Re-fire suggestions / genres when we're on that tab so the SWR
      // cache has a chance to bring in fresh data on a back-navigation.
      if (this.viewMode() === 'suggestions') {
        void this.loadSuggestions();
      } else if (this.viewMode() === 'genres') {
        void this.loadGenres();
      }
      this.scrollMemory.restoreSticky(scrollKey);
      if (this.tv.isTv()) {
        this.arrivedViaBack = true;
        afterNextRender(() => this.applyDefaultFocus(lib.id), { injector: this.injector });
      }
    });
    this.detachedSub = this.reuseStrategy.detached$.subscribe((key) => {
      if (key !== ownKey) return;
      this.detached = true;
      const lib = this.library();
      if (lib) this.scrollMemory.deactivateIf(`library-${lib.id}`);
    });
    // Native app-resume: refresh the grid when the app returns to the
    // foreground after a spell away and this library is the visible page.
    this.resumeSub = this.appResume.resume$.subscribe(() => {
      if (this.detached) return;
      const lib = this.library();
      if (lib) void this.load(lib.id, true);
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
        void this.load(lib.id, true);
        if (this.viewMode() === 'genres') void this.loadGenres();
        else if (this.viewMode() === 'collections') void this.loadCollections();
        else if (this.viewMode() === 'suggestions') void this.loadSuggestions();
      }
    });
  }

  ngOnDestroy() {
    this.scrollMemory.deactivate();
    this.list.destroy();
    this.navbar.clearPageTitle();
    this.navStartSub?.unsubscribe();
    this.attachedSub?.unsubscribe();
    this.detachedSub?.unsubscribe();
    this.queryParamSub?.unsubscribe();
    this.resumeSub?.unsubscribe();
  }

  private applyDefaultFocus(libraryId: number) {
    const root = document.querySelector<HTMLElement>('app-library') ?? document.body;
    const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex="0"]';
    if (this.arrivedViaBack) {
      const saved = this.focusMemory.retrieve(`library-${libraryId}`);
      const container = saved
        ? root.querySelector<HTMLElement>(`[data-library-focus="${CSS.escape(saved)}"]`)
        : null;
      const target = container?.matches(FOCUSABLE)
        ? container
        : container?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
      if (target) {
        target.focus({ preventScroll: false });
        return;
      }
    }
    // Default: first card in the grid.
    const firstCard = root.querySelector<HTMLElement>('[data-library-focus^="media:"]');
    const target = firstCard?.matches(FOCUSABLE)
      ? firstCard
      : firstCard?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus({ preventScroll: false });
  }

  scrollToLetter(letter: string) {
    this.list.scrollToLetter(letter, (m) => m.title, 'media');
  }

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
    this.collectionsLoading.set(true);
    try {
      const rows = await this.mediaService.getCollections(lib.id).catch(() => null);
      if (rows) this.collectionsList.set(rows);
    } finally {
      this.collectionsLoading.set(false);
    }
  }

  /** Fetches the genres aggregate (count + sample posters) for the
   *  current library. Same SWR pattern as `loadSuggestions`. */
  private async loadGenres(): Promise<void> {
    const lib = this.library();
    if (!lib) return;
    this.genresLoading.set(true);
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
    this.suggestionsLoading.set(true);
    try {
      const [cw, recs] = await Promise.all([
        this.streamingApi.getContinueWatching(lib.id).catch(() => null),
        this.streamingApi
          .getRecommendations({ libraryId: lib.id, limit: 30 })
          .catch(() => null),
      ]);
      if (cw) this.suggestionsContinue.set(cw);
      if (recs) this.suggestionsRecommendations.set(recs);
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

  /** Reflect the current state in the URL. `push` adds a real history
   *  entry instead of replacing — used for the genres-list → genre-filter
   *  transition so the browser back button returns to the Genres list. */
  private syncQueryParams(push = false) {
    const params: Record<string, string> = {};
    if (this.searchQuery()) params['q'] = this.searchQuery();
    if (this.filterMonitored()) params['monitored'] = this.filterMonitored();
    if (this.filterStatus()) params['status'] = this.filterStatus();
    if (this.filterWatched()) params['watched'] = this.filterWatched();
    if (this.sortBy() !== 'title') params['sortBy'] = this.sortBy();
    if (this.sortOrder() !== 'ASC') params['sortOrder'] = this.sortOrder();
    if (this.viewMode() !== 'all') params['view'] = this.viewMode();
    if (this.selectedGenre()) params['genre'] = this.selectedGenre();
    if (this.selectedCollectionId()) params['collectionId'] = String(this.selectedCollectionId());
    this.skipQueryParamSync = true;
    void this.router.navigate([], { queryParams: params, replaceUrl: !push });
    this.saveFilters();
  }

  private get storageKey(): string {
    return `fliks.filters.library.${this.libraryName()}`;
  }

  private saveFilters() {
    const data: Record<string, string> = {};
    if (this.searchQuery()) data['q'] = this.searchQuery();
    if (this.filterMonitored()) data['monitored'] = this.filterMonitored();
    if (this.filterStatus()) data['status'] = this.filterStatus();
    if (this.filterWatched()) data['watched'] = this.filterWatched();
    if (this.sortBy() !== 'title') data['sortBy'] = this.sortBy();
    if (this.sortOrder() !== 'ASC') data['sortOrder'] = this.sortOrder();
    if (this.viewMode() !== 'all') data['view'] = this.viewMode();
    if (this.selectedGenre()) data['genre'] = this.selectedGenre();
    if (this.selectedCollectionId()) data['collectionId'] = String(this.selectedCollectionId());
    localStorage.setItem(this.storageKey, JSON.stringify(data));
  }

  private loadFilters(name: string): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem(`fliks.filters.library.${name}`) ?? '{}');
    } catch {
      return {};
    }
  }

  private async load(libraryId?: number, silent = false) {
    if (!libraryId) return;
    if (!silent) this.loading.set(true);
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
        if (res) this.list.setItems(res.data, (m) => m.title);
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
