import {
  Component,
  ChangeDetectionStrategy,
  signal,
  effect,
  untracked,
  inject,
  Injector,
  OnDestroy,
  OnInit,
  AfterViewInit,
  ElementRef,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TvSelectDirective } from '../../shared/directives/tv-select.directive';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { TranslateModule } from '@ngx-translate/core';
import { MediaService, Media, SearchParams } from '../../core/services/api/media.service';
import { StreamingApiService, RecommendationItem } from '../../core/services/api/streaming-api.service';
import {
  MetadataService,
  MetadataSearchResult,
  DiscoverFilters,
} from '../../core/services/api/metadata.service';
import { AuthService } from '../../core/services/auth.service';
import { RequestsService, FliksRequestStatus } from '../../core/services/api/requests.service';
import { SearchStateService } from '../../core/services/search-state.service';
import { SocialApiService } from '../../core/services/api/social-api.service';
import { TvService } from '../../core/services/tv.service';
import { DeviceService } from '../../core/services/device.service';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { CachingReuseStrategy } from '../../core/services/route-reuse.strategy';
import { MediaType } from '../../core/enums/media-type.enum';
import { MediaCardComponent, CardBadge } from '../../shared/components/media-card/media-card';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';
import { DropdownMenuComponent } from '../../shared/components/dropdown-menu';
import { NgTemplateOutlet } from '@angular/common';
import { ModalHeaderComponent } from '../../shared/components/modal-header';
import { LucideSearch, LucideX, LucideSettings } from '@lucide/angular';
import { Capacitor } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';
import { UserAvatarComponent } from '../../shared/components/user-avatar/user-avatar';

@Component({
  selector: 'app-search',
  imports: [TvSelectDirective, UserAvatarComponent, FormsModule, TranslateModule, NgTemplateOutlet, MediaCardComponent, HorizontalScrollerComponent, DropdownMenuComponent, LucideSearch, LucideX, LucideSettings, ModalHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './search.html',
})
export class SearchComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly mediaService = inject(MediaService);
  private readonly metadata = inject(MetadataService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);
  /** Opted out of the social layer → the people tab is hidden. */
  protected readonly sharingDisabled = this.auth.sharingDisabled;
  private readonly requestsApi = inject(RequestsService);
  private readonly scrollMemory = inject(ScrollMemoryService);
  private readonly reuseStrategy = inject(CachingReuseStrategy);
  private readonly injector = inject(Injector);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly social = inject(SocialApiService);
  readonly tv = inject(TvService);
  private readonly device = inject(DeviceService);
  readonly state = inject(SearchStateService);

  /** TMDB /discover sort options (label keys resolved in the template). */
  readonly sortOptions = [
    { value: 'popularity.desc', labelKey: 'search.sort_popularity' },
    { value: 'vote_average.desc', labelKey: 'search.sort_rating' },
    { value: 'primary_release_date.desc', labelKey: 'search.sort_recent' },
  ];
  readonly filterSheet = viewChild<ElementRef<HTMLDialogElement>>('filterSheet');
  private lastDiscoveryKey = '';
  /** Load discovery rows whenever the empty state is showing, keyed on the
   *  active tab + external-search toggle so a tab/toggle change refreshes them. */
  private readonly discoveryEffect = effect(() => {
    const tab = this.state.tab();
    const ct = this.state.contentType();
    const external = this.state.externalEnabled();
    if (this.state.hasQuery() || tab !== 'videos') return;
    const key = `${ct}:${external}`;
    if (key === this.lastDiscoveryKey) return;
    this.lastDiscoveryKey = key;
    void this.loadDiscovery(ct, external);
  });

  readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');

  /** Refocus the input whenever something external (e.g. the bottom-
   *  dock search button on mobile re-tapping the same route) requests
   *  it. Selecting the current text lets the user immediately
   *  overwrite the existing query. */
  private readonly externalFocusEffect = effect(() => {
    const id = this.state.focusRequestId();
    if (id === 0) return;
    // Defer to the next tick so the effect runs even when the view
    // hasn't fully reconciled yet (e.g. just navigated to /search).
    setTimeout(() => {
      const el = this.searchInput()?.nativeElement;
      if (!el) return;
      el.focus();
      el.select();
    }, 0);
  });

  /** Preload the discover panel with a genre asked for from elsewhere (e.g. a
   *  profile taste chip). Lives on the instance so it fires across route reuse,
   *  where ngOnInit wouldn't re-run. */
  private readonly genreFilterEffect = effect(() => {
    const req = this.state.genreFilterRequest();
    if (!req) return;
    // One-shot: untracked so the applied filter reads don't become deps.
    untracked(() => {
      void this.applyGenreFilter(req.genreId);
      this.state.genreFilterRequest.set(null);
    });
  });

  /** Keep the discover genre list populated for the active content type so the
   *  filter panel's genre chips render during a text search too. Movie genres
   *  cover the "all" and "movie" tabs; series uses the TV list. */
  private readonly discoverGenreEffect = effect(() => {
    this.state.tab();
    this.state.contentType();
    this.state.externalEnabled();
    untracked(() => void this.ensureDiscoverGenres());
  });

  /** Auto-apply the discover panel filters (debounced) — no explicit apply
   *  button. The run is untracked so its writes can't feed back into the effect.
   *  See applyFiltersNow for what each state does. */
  private readonly liveFilterEffect = effect(() => {
    this.state.discoverSelectedGenres();
    this.state.discoverSort();
    this.state.discoverVoteMin();
    this.state.discoverYearMin();
    this.state.discoverYearMax();
    untracked(() => {
      if (this.state.tab() !== 'videos') return;
      if (this.filterDebounce) clearTimeout(this.filterDebounce);
      this.filterDebounce = setTimeout(() => void this.applyFiltersNow(), 300);
    });
  });

  /** Apply the current filters to the right source:
   *  - text query  → the local library query (external post-filters reactively);
   *  - no query + filters + external on  → TMDB /discover;
   *  - no query + filters + external off → filtered local library browse;
   *  - no query + no filters → back to the discovery rows. */
  private async applyFiltersNow(): Promise<void> {
    if (this.state.tab() !== 'videos') return;
    const ct = this.state.contentType();
    if (this.state.hasQuery()) {
      const q = this.state.query().trim();
      if (this.filterSig(q, ct) !== this.lastLocalSig) await this.runLocalSearch(q, ct);
      return;
    }
    if (!this.state.filtersEngaged()) {
      this.state.discoverActive.set(false);
      this.state.discoverResults.set([]);
      return;
    }
    if (this.state.externalEnabled()) {
      await this.applyDiscover();
    } else {
      this.state.discoverActive.set(true);
      await this.runLocalSearch('', ct);
    }
  }

  readonly requestedTmdbIds = signal<Map<number, FliksRequestStatus>>(new Map());

  private static readonly SCROLL_KEY = 'search';
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private filterDebounce: ReturnType<typeof setTimeout> | null = null;
  /** Movie/series bucket the discover genre list was last loaded for. */
  private lastGenreType = '';
  private attachedSub?: Subscription;
  private detachedSub?: Subscription;

  ngOnInit() {
    this.scrollMemory.activate(SearchComponent.SCROLL_KEY);
    this.scrollMemory.restore(SearchComponent.SCROLL_KEY, this.injector);

    // Route is cached on navigate-away (data: { reuse: true }). Search results
    // already live in SearchStateService so there's nothing to refetch — we
    // only need to re-claim the scroll key and put scroll back where it was.
    const ownKey = this.reuseStrategy.keyFor(this.route.snapshot);
    this.attachedSub = this.reuseStrategy.attached$.subscribe((key) => {
      if (key !== ownKey) return;
      this.scrollMemory.activate(SearchComponent.SCROLL_KEY);
      this.scrollMemory.restoreSticky(SearchComponent.SCROLL_KEY);
    });
    this.detachedSub = this.reuseStrategy.detached$.subscribe((key) => {
      if (key === ownKey) this.scrollMemory.deactivateIf(SearchComponent.SCROLL_KEY);
    });
  }

  ngAfterViewInit() {
    // Auto-focus on first visit only on non-touch devices (desktop). On touch
    // surfaces this would pop the soft keyboard on arrival; there the keyboard
    // opens only on an explicit re-tap of the search dock (requestFocus).
    if (!this.state.hasQuery() && !this.device.isTouch()) {
      setTimeout(() => this.searchInput()?.nativeElement.focus(), 100);
    }
  }

  ngOnDestroy() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (this.filterDebounce) clearTimeout(this.filterDebounce);
    this.scrollMemory.deactivate();
    this.attachedSub?.unsubscribe();
    this.detachedSub?.unsubscribe();
    this.removeOutsidePointerListener();
  }

  /** Outside-tap → blur. Capacitor's iOS WebView doesn't reliably blur an
   *  input when the user taps a non-interactive element (no cursor:pointer,
   *  no click handler). We register a one-shot pointerdown listener while
   *  the input has focus that blurs it on any tap outside its wrapper. */
  private outsidePointerHandler: ((e: Event) => void) | null = null;

  protected onInputFocus() {
    if (this.outsidePointerHandler) return;
    const inputEl = this.searchInput()?.nativeElement;
    if (!inputEl) return;
    this.outsidePointerHandler = (e: Event) => {
      const target = e.target as Node | null;
      if (!target) return;
      // Tap inside the input or the surrounding <form> (clear button, icon)
      // — keep focus.
      if (inputEl.closest('form')?.contains(target)) return;
      inputEl.blur();
    };
    document.addEventListener('pointerdown', this.outsidePointerHandler, { capture: true });
  }

  protected onInputBlur() {
    this.removeOutsidePointerListener();
    // Capacitor WebView sometimes keeps the soft keyboard up after a JS
    // blur — force it down to match the visual state.
    if (Capacitor.isNativePlatform()) {
      Keyboard.hide().catch(() => {});
    }
  }

  /** Called from the <form> ngSubmit (virtual-keyboard Enter on iOS and
   *  Android both fire it through the native browser form contract). */
  protected dismissKeyboard() {
    this.searchInput()?.nativeElement.blur();
  }

  private removeOutsidePointerListener() {
    if (this.outsidePointerHandler) {
      document.removeEventListener('pointerdown', this.outsidePointerHandler, { capture: true });
      this.outsidePointerHandler = null;
    }
  }

  async loadRequestedIds() {
    if (this.auth.hasPermission('requests.create') && !this.auth.hasPermission('media.create')) {
      try {
        const res = await this.requestsApi.list({ limit: 200 });
        this.requestedTmdbIds.set(new Map(res.data.map(r => [r.tmdbId, r.status])));
      } catch { /* ignore */ }
    }
  }

  onQueryInput(value: string) {
    this.state.query.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    // People keeps searching on an empty query (→ default roster); videos clear.
    if (value.trim() || this.state.tab() === 'people') {
      this.searchTimer = setTimeout(() => this.runSearch(), 350);
    } else {
      this.state.localResults.set([]);
      this.state.externalResults.set([]);
      this.state.localLoading.set(false);
      this.state.externalLoading.set(false);
      // An engaged filter keeps browsing (discover / local) with no text query.
      if (this.filterDebounce) clearTimeout(this.filterDebounce);
      void this.applyFiltersNow();
    }
  }

  setTab(t: 'videos' | 'people') {
    if (t === this.state.tab()) return;
    this.state.tab.set(t);
    // Load the default member roster when switching to people (even with no
    // query); videos only searches when a query is present.
    if (t === 'people' || this.state.query().trim()) {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.runSearch();
    }
  }

  setContentType(ct: 'all' | 'movie' | 'series') {
    if (ct === this.state.contentType()) return;
    // Discover genres/results are type-specific — drop them when the type changes.
    this.state.resetDiscover();
    this.state.contentType.set(ct);
    if (this.state.query().trim()) {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.runSearch();
    }
  }

  toggleExternal() {
    this.state.externalEnabled.update(v => !v);
    const on = this.state.externalEnabled();
    if (!on) {
      this.state.externalResults.set([]);
      this.state.externalLoading.set(false);
    }
    if (this.state.query().trim()) {
      if (on) {
        if (this.searchTimer) clearTimeout(this.searchTimer);
        this.runSearch();
      }
    } else {
      // Discover mode: switch the filter source (TMDB /discover ↔ local browse).
      if (this.filterDebounce) clearTimeout(this.filterDebounce);
      void this.applyFiltersNow();
    }
  }

  clearQuery() {
    this.state.clear();
    this.searchInput()?.nativeElement.focus();
    // Clearing the query isn't tracked by liveFilterEffect, so re-apply any
    // engaged filter (browse) instead of dropping to unfiltered discovery rows.
    if (this.filterDebounce) clearTimeout(this.filterDebounce);
    void this.applyFiltersNow();
  }

  openProfile(userId: number) {
    void this.router.navigate(['/profile', userId]);
  }

  /**
   * Populate the empty-state discovery rows. Trending/popular + the discover
   * genre list are TMDB and only fetched when external search is enabled;
   * suggestions always come from the viewer's own library. Each fetch fails
   * soft (empty row) so a missing provider / cold-start user just drops that
   * section. Rows follow the active `movie`/`series`/`all` tab.
   */
  private async loadDiscovery(
    ct: 'all' | 'movie' | 'series',
    external: boolean,
  ): Promise<void> {
    this.state.discoveryLoading.set(true);
    try {
      const isSeries = ct === 'series';
      const isMovie = ct === 'movie';

      const recs = await this.streamingApi
        .getRecommendations({ limit: 30 })
        .catch(() => []);
      if (this.staleDiscovery(ct, external)) return;
      this.state.discoveryRecommendations.set(
        isMovie || isSeries
          ? recs.filter((r) => r.media.type === (isMovie ? 'movie' : 'series'))
          : recs,
      );

      if (!external) {
        this.state.discoveryTrending.set([]);
        this.state.discoveryPopular.set([]);
        // Keep discoverGenres — the filter panel's genre chips + name mapping
        // are needed for the local-library browse when external search is off.
        this.state.discoverySuggestions.set([]);
        return;
      }
      const [trending, popular, genres] = await Promise.all([
        this.fetchTrending(ct, this.state.trendingWindow()),
        this.fetchPopular(ct),
        (isSeries ? this.metadata.getTvGenres() : this.metadata.getMovieGenres()).catch(
          () => [],
        ),
      ]);
      if (this.staleDiscovery(ct, external)) return;
      this.state.discoveryTrending.set(trending);
      this.state.discoveryPopular.set(popular);
      this.state.discoverGenres.set(genres);
      this.loadRequestedIds();

      // "Suggestions pour vous" (external): TMDB catalog matching the viewer's
      // taste — NOT limited to the library. Derive their top genres from the
      // library recommendations, then discover those genres on TMDB.
      const topGenreIds = this.deriveTasteGenreIds(this.state.discoveryRecommendations(), genres);
      const suggestions = await this.fetchSuggestions(ct, topGenreIds);
      if (this.staleDiscovery(ct, external)) return;
      this.state.discoverySuggestions.set(suggestions);
    } finally {
      this.state.discoveryLoading.set(false);
    }
  }

  /** Map the viewer's most-recurring recommendation genres to TMDB genre ids. */
  private deriveTasteGenreIds(
    recs: RecommendationItem[],
    genres: { id: number; name: string }[],
  ): number[] {
    const freq = new Map<string, number>();
    for (const r of recs) {
      for (const g of r.media.genres ?? []) {
        const k = g.toLowerCase();
        freq.set(k, (freq.get(k) ?? 0) + 1);
      }
    }
    const nameToId = new Map(genres.map((g) => [g.name.toLowerCase(), g.id]));
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => nameToId.get(name))
      .filter((id): id is number => id != null)
      .slice(0, 3);
  }

  /** TMDB discover across the taste genres (one call per genre, merged
   *  round-robin + deduped — an OR the AND-only /discover can't express). */
  private async fetchSuggestions(
    ct: 'all' | 'movie' | 'series',
    genreIds: number[],
  ): Promise<MetadataSearchResult[]> {
    if (!genreIds.length) return [];
    const isSeries = ct === 'series';
    const perGenre = await Promise.all(
      genreIds.map((id) =>
        (isSeries
          ? this.metadata.discoverTv({ genreIds: [id], sort: 'popularity.desc' })
          : this.metadata.discoverMovies({ genreIds: [id], sort: 'popularity.desc' })
        ).catch(() => [] as MetadataSearchResult[]),
      ),
    );
    const out: MetadataSearchResult[] = [];
    const seen = new Set<number>();
    const maxLen = Math.max(0, ...perGenre.map((a) => a.length));
    for (let i = 0; i < maxLen; i++) {
      for (const arr of perGenre) {
        const r = arr[i];
        if (r && !seen.has(r.tmdbId)) {
          seen.add(r.tmdbId);
          out.push(r);
        }
      }
    }
    return out.slice(0, 24);
  }

  private async fetchTrending(
    ct: 'all' | 'movie' | 'series',
    window: 'day' | 'week',
  ): Promise<MetadataSearchResult[]> {
    if (ct === 'series') return this.metadata.getTrendingTv(window).catch(() => []);
    if (ct === 'movie') return this.metadata.getTrendingMovies(window).catch(() => []);
    const [m, t] = await Promise.all([
      this.metadata.getTrendingMovies(window).catch(() => []),
      this.metadata.getTrendingTv(window).catch(() => []),
    ]);
    return this.interleave(m, t);
  }

  private async fetchPopular(
    ct: 'all' | 'movie' | 'series',
  ): Promise<MetadataSearchResult[]> {
    if (ct === 'series') return this.metadata.getPopularTv().catch(() => []);
    if (ct === 'movie') return this.metadata.getPopularMovies().catch(() => []);
    const [m, t] = await Promise.all([
      this.metadata.getPopularMovies().catch(() => []),
      this.metadata.getPopularTv().catch(() => []),
    ]);
    return this.interleave(m, t);
  }

  /** True if the type/toggle moved on while a discovery fetch was in flight. */
  private staleDiscovery(
    ct: 'all' | 'movie' | 'series',
    external: boolean,
  ): boolean {
    return (
      this.state.tab() !== 'videos' ||
      this.state.contentType() !== ct ||
      this.state.externalEnabled() !== external
    );
  }

  /** Alternate two lists so a mixed row isn't all movies then all series. */
  private interleave(
    a: MetadataSearchResult[],
    b: MetadataSearchResult[],
  ): MetadataSearchResult[] {
    const out: MetadataSearchResult[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i]) out.push(a[i]);
      if (b[i]) out.push(b[i]);
    }
    return out;
  }

  recLink(rec: RecommendationItem): string[] {
    return ['/' + (rec.media.type === 'series' ? 'series' : 'movies'), '' + rec.media.id];
  }

  // ── Discover panel ──

  setTrendingWindow(w: 'day' | 'week') {
    if (this.state.trendingWindow() === w) return;
    this.state.trendingWindow.set(w);
    void this.fetchTrending(this.state.contentType(), w).then((rows) => {
      if (this.state.trendingWindow() === w) this.state.discoveryTrending.set(rows);
    });
  }

  toggleGenre(id: number) {
    this.state.discoverSelectedGenres.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Run the TMDB /discover query from the current panel filters and switch
   *  the content area to the results grid. Stale responses (a later filter
   *  change superseded this one) are dropped. */
  async applyDiscover() {
    const ct = this.state.contentType();
    const sig = (this.lastDiscoverSig = this.filterSig('', ct));
    const opts: DiscoverFilters = {
      genreIds: [...this.state.discoverSelectedGenres()],
      sort: this.state.discoverSort(),
      voteMin: this.state.discoverVoteMin() || undefined,
      yearMin: this.state.discoverYearMin(),
      yearMax: this.state.discoverYearMax(),
    };
    this.state.discoverActive.set(true);
    this.state.discoverLoading.set(true);
    const fresh = () => this.lastDiscoverSig === sig;
    try {
      const rows =
        ct === 'series'
          ? await this.metadata.discoverTv(opts)
          : await this.metadata.discoverMovies(opts);
      if (fresh()) {
        this.state.discoverResults.set(rows);
        this.loadRequestedIds();
      }
    } catch {
      if (fresh()) this.state.discoverResults.set([]);
    } finally {
      if (fresh()) this.state.discoverLoading.set(false);
    }
  }
  private lastDiscoverSig = '';

  clearDiscover() {
    this.state.resetDiscover();
  }

  /** Preload the discover panel on a genre id (resolved by the caller — a
   *  profile taste chip — so it's language-proof). The filter auto-applies via
   *  liveFilterEffect, routed to the right source by the external toggle. */
  private applyGenreFilter(genreId: number): void {
    this.state.tab.set('videos');
    this.state.query.set('');
    this.state.discoverSelectedGenres.set(new Set([genreId]));
  }

  /** Map the panel sort to the local sortBy/sortOrder, or null for the default
   *  (keeps the title relevance order — the panel default has no local column). */
  private mapPanelSort(): { sortBy: string; sortOrder: 'ASC' | 'DESC' } | null {
    const s = this.state.discoverSort();
    if (s === 'primary_release_date.desc') return { sortBy: 'year', sortOrder: 'DESC' };
    if (s === 'vote_average.desc') return { sortBy: 'rating', sortOrder: 'DESC' };
    return null;
  }

  /** Signature of the inputs that shape the local library query, so a re-run
   *  can be skipped when nothing changed and a stale revalidation ignored. */
  private filterSig(q: string, ct: string): string {
    return JSON.stringify({
      q,
      ct,
      g: [...this.state.discoverSelectedGenres()].sort((a, b) => a - b),
      ymin: this.state.discoverYearMin(),
      ymax: this.state.discoverYearMax(),
      vmin: this.state.discoverVoteMin(),
      sort: this.state.discoverSort(),
    });
  }
  private lastLocalSig = '';

  /** Load the discover genre list for the active content type when missing, so
   *  the filter panel's genre chips render during a text search. Fails soft. */
  private async ensureDiscoverGenres(): Promise<void> {
    if (this.state.tab() !== 'videos') return;
    const type = this.state.contentType() === 'series' ? 'series' : 'movie';
    if (type === this.lastGenreType && this.state.discoverGenres().length) return;
    this.lastGenreType = type;
    const stale = () =>
      this.state.tab() !== 'videos' ||
      (this.state.contentType() === 'series' ? 'series' : 'movie') !== type;
    try {
      const genres =
        type === 'series'
          ? await this.metadata.getTvGenres()
          : await this.metadata.getMovieGenres();
      if (!stale()) this.state.discoverGenres.set(genres);
    } catch {
      if (!stale()) this.state.discoverGenres.set([]);
    }
  }

  openFilterSheet() {
    this.filterSheet()?.nativeElement.showModal();
  }

  /** Series toggle via the bulk endpoint; movies need a local file. */
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
      this.state.localResults.update((list) =>
        list.map((x) =>
          x.id === m.id
            ? { ...x, watched, progressPercent: watched ? 0 : x.progressPercent }
            : x,
        ),
      );
    } catch {
      /* global error toast */
    }
  }

  private async runSearch() {
    const q = this.state.query().trim();

    // People is a distinct surface — no local/external media lookups. Runs even
    // with an empty query: the backend then returns the default member roster.
    if (this.state.tab() === 'people') {
      this.state.peopleLoading.set(true);
      try {
        const results = await this.social.searchUsers(q);
        // Ignore a stale response if the query/tab moved on meanwhile.
        if (this.state.query().trim() !== q || this.state.tab() !== 'people') return;
        this.state.peopleResults.set(results);
      } catch {
        if (this.state.query().trim() === q && this.state.tab() === 'people') {
          this.state.peopleResults.set([]);
        }
      } finally {
        this.state.peopleLoading.set(false);
      }
      return;
    }

    if (!q) return;

    const ct = this.state.contentType();
    await this.runLocalSearch(q, ct);
    if (this.state.externalEnabled()) await this.runExternalSearch(q, ct);
  }

  /** Local library query with the discover panel filters pushed to the backend
   *  (q + genres + year + rating + sort). Re-run standalone on a filter change. */
  private async runLocalSearch(q: string, ct: 'all' | 'movie' | 'series') {
    const sig = (this.lastLocalSig = this.filterSig(q, ct));
    // Selected genres are mapped to names via the loaded genre list; wait for it
    // when a genre is selected so the filter isn't silently dropped.
    if (this.state.discoverSelectedGenres().size) await this.ensureDiscoverGenres();
    else void this.ensureDiscoverGenres();
    const type: MediaType | undefined = ct === 'all' ? undefined : ct;
    const sort = this.mapPanelSort();
    const localParams: SearchParams = { q, limit: 20, sortBy: sort?.sortBy ?? 'title' };
    if (sort) localParams.sortOrder = sort.sortOrder;
    if (type) localParams.type = type;
    const genres = this.state.selectedGenreNames();
    if (genres.length) localParams.genres = genres;
    const yearMin = this.state.discoverYearMin();
    if (yearMin != null) localParams.yearMin = yearMin;
    const yearMax = this.state.discoverYearMax();
    if (yearMax != null) localParams.yearMax = yearMax;
    const voteMin = this.state.discoverVoteMin();
    if (voteMin) localParams.voteMin = voteMin;

    const fresh = () => this.filterSig(this.state.query().trim(), this.state.contentType()) === sig;
    this.state.localLoading.set(true);
    try {
      const res = await this.mediaService.getAll(localParams);
      if (fresh()) this.state.localResults.set(res.data);
    } catch {
      if (fresh()) this.state.localResults.set([]);
    } finally {
      this.state.localLoading.set(false);
    }
    queueMicrotask(() => {
      if (!fresh()) return;
      void this.mediaService
        .getAll(localParams, { force: true })
        .then((data) => { if (fresh()) this.state.localResults.set(data.data); })
        .catch(() => {});
    });
  }

  /** External provider (TMDB) title search. Not re-run on filter changes — the
   *  state computeds re-filter the fetched rows client-side. */
  private async runExternalSearch(q: string, ct: 'all' | 'movie' | 'series') {
    const fresh = () => this.state.query().trim() === q && this.state.contentType() === ct;
    this.state.externalLoading.set(true);
    try {
      let rows: MetadataSearchResult[];
      if (ct === 'movie') {
        rows = await this.metadata.searchMovie(q);
      } else if (ct === 'series') {
        rows = await this.metadata.searchTv(q);
      } else {
        const [movies, tv] = await Promise.all([
          this.metadata.searchMovie(q),
          this.metadata.searchTv(q),
        ]);
        rows = [...movies, ...tv].sort((a, b) => b.rating - a.rating);
      }
      if (fresh()) {
        this.state.externalResults.set(rows);
        this.loadRequestedIds();
      }
    } catch {
      if (fresh()) this.state.externalResults.set([]);
    } finally {
      this.state.externalLoading.set(false);
    }
  }

  cardStatus(row: MetadataSearchResult): CardBadge {
    if (row.existingMediaId) return 'library';
    const reqStatus = this.requestedTmdbIds().get(row.tmdbId);
    if (!reqStatus) return null;
    if (reqStatus === 'declined' || reqStatus === 'failed') return 'declined';
    if (reqStatus === 'available') return 'library';
    return 'pending';
  }

  onExternalCardClick(row: MetadataSearchResult) {
    if (row.existingMediaId) {
      const prefix = row.existingMediaType === 'series' ? '/series' : '/movies';
      void this.router.navigate([prefix, row.existingMediaId]);
    } else {
      const provider = row.provider ?? 'tmdb';
      const externalId = provider === 'tvdb' ? String(row.tvdbId ?? row.tmdbId) : String(row.tmdbId);
      const prefix = row.mediaType === 'series' ? '/add/tv' : '/add/movie';
      void this.router.navigate([prefix, provider, externalId]);
    }
  }
}
