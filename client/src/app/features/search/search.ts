import {
  Component,
  ChangeDetectionStrategy,
  signal,
  effect,
  inject,
  Injector,
  OnDestroy,
  OnInit,
  AfterViewInit,
  ElementRef,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { TranslateModule } from '@ngx-translate/core';
import { MediaService, Media } from '../../core/services/api/media.service';
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
import { initialsAvatar } from '../../core/utils/initials-avatar';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { CachingReuseStrategy } from '../../core/services/route-reuse.strategy';
import { MediaType } from '../../core/enums/media-type.enum';
import { MediaCardComponent, CardBadge } from '../../shared/components/media-card/media-card';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';
import { DropdownMenuComponent } from '../../shared/components/dropdown-menu';
import { NgTemplateOutlet } from '@angular/common';
import { LucideSearch, LucideX, LucideSettings } from '@lucide/angular';
import { Capacitor } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';

@Component({
  selector: 'app-search',
  imports: [FormsModule, TranslateModule, RouterLink, NgTemplateOutlet, MediaCardComponent, HorizontalScrollerComponent, DropdownMenuComponent, LucideSearch, LucideX, LucideSettings],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './search.html',
})
export class SearchComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly mediaService = inject(MediaService);
  private readonly metadata = inject(MetadataService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);
  private readonly requestsApi = inject(RequestsService);
  private readonly scrollMemory = inject(ScrollMemoryService);
  private readonly reuseStrategy = inject(CachingReuseStrategy);
  private readonly injector = inject(Injector);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly social = inject(SocialApiService);
  readonly tv = inject(TvService);
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
    const filter = this.state.filter();
    const external = this.state.externalEnabled();
    if (this.state.hasQuery() || filter === 'people') return;
    const key = `${filter}:${external}`;
    if (key === this.lastDiscoveryKey) return;
    this.lastDiscoveryKey = key;
    void this.loadDiscovery(filter, external);
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

  readonly requestedTmdbIds = signal<Map<number, FliksRequestStatus>>(new Map());

  private static readonly SCROLL_KEY = 'search';
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
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
    // Focus only if no existing query (first visit)
    if (!this.state.hasQuery()) {
      setTimeout(() => this.searchInput()?.nativeElement.focus(), 100);
    }
  }

  ngOnDestroy() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
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
    if (value.trim()) {
      this.searchTimer = setTimeout(() => this.runSearch(), 350);
    } else {
      this.state.localResults.set([]);
      this.state.externalResults.set([]);
      this.state.localLoading.set(false);
      this.state.externalLoading.set(false);
    }
  }

  setFilter(f: 'all' | 'movie' | 'series' | 'people') {
    // Discover genres/results are type-specific — drop them when the tab changes.
    if (f !== this.state.filter()) this.state.resetDiscover();
    this.state.filter.set(f);
    if (this.state.query().trim()) {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.runSearch();
    }
  }

  toggleExternal() {
    this.state.externalEnabled.update(v => !v);
    if (this.state.externalEnabled()) {
      // Re-run search to fetch external results
      if (this.state.query().trim()) {
        if (this.searchTimer) clearTimeout(this.searchTimer);
        this.runSearch();
      }
    } else {
      this.state.externalResults.set([]);
      this.state.externalLoading.set(false);
    }
  }

  clearQuery() {
    this.state.clear();
    this.searchInput()?.nativeElement.focus();
  }

  avatar(name: string) {
    return initialsAvatar(name);
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
    filter: 'all' | 'movie' | 'series' | 'people',
    external: boolean,
  ): Promise<void> {
    this.state.discoveryLoading.set(true);
    try {
      const isSeries = filter === 'series';
      const isMovie = filter === 'movie';

      const recs = await this.streamingApi
        .getRecommendations({ limit: 30 })
        .catch(() => []);
      if (this.staleDiscovery(filter, external)) return;
      this.state.discoveryRecommendations.set(
        isMovie || isSeries
          ? recs.filter((r) => r.media.type === (isMovie ? 'movie' : 'series'))
          : recs,
      );

      if (!external) {
        this.state.discoveryTrending.set([]);
        this.state.discoveryPopular.set([]);
        this.state.discoverGenres.set([]);
        this.state.discoverySuggestions.set([]);
        return;
      }
      const [trending, popular, genres] = await Promise.all([
        this.fetchTrending(filter, this.state.trendingWindow()),
        this.fetchPopular(filter),
        (isSeries ? this.metadata.getTvGenres() : this.metadata.getMovieGenres()).catch(
          () => [],
        ),
      ]);
      if (this.staleDiscovery(filter, external)) return;
      this.state.discoveryTrending.set(trending);
      this.state.discoveryPopular.set(popular);
      this.state.discoverGenres.set(genres);
      this.loadRequestedIds();

      // "Suggestions pour vous" (external): TMDB catalog matching the viewer's
      // taste — NOT limited to the library. Derive their top genres from the
      // library recommendations, then discover those genres on TMDB.
      const topGenreIds = this.deriveTasteGenreIds(this.state.discoveryRecommendations(), genres);
      const suggestions = await this.fetchSuggestions(filter, topGenreIds);
      if (this.staleDiscovery(filter, external)) return;
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
    filter: 'all' | 'movie' | 'series' | 'people',
    genreIds: number[],
  ): Promise<MetadataSearchResult[]> {
    if (!genreIds.length) return [];
    const isSeries = filter === 'series';
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
    filter: 'all' | 'movie' | 'series' | 'people',
    window: 'day' | 'week',
  ): Promise<MetadataSearchResult[]> {
    if (filter === 'series') return this.metadata.getTrendingTv(window).catch(() => []);
    if (filter === 'movie') return this.metadata.getTrendingMovies(window).catch(() => []);
    const [m, t] = await Promise.all([
      this.metadata.getTrendingMovies(window).catch(() => []),
      this.metadata.getTrendingTv(window).catch(() => []),
    ]);
    return this.interleave(m, t);
  }

  private async fetchPopular(
    filter: 'all' | 'movie' | 'series' | 'people',
  ): Promise<MetadataSearchResult[]> {
    if (filter === 'series') return this.metadata.getPopularTv().catch(() => []);
    if (filter === 'movie') return this.metadata.getPopularMovies().catch(() => []);
    const [m, t] = await Promise.all([
      this.metadata.getPopularMovies().catch(() => []),
      this.metadata.getPopularTv().catch(() => []),
    ]);
    return this.interleave(m, t);
  }

  /** True if the tab/toggle moved on while a discovery fetch was in flight. */
  private staleDiscovery(
    filter: 'all' | 'movie' | 'series' | 'people',
    external: boolean,
  ): boolean {
    return this.state.filter() !== filter || this.state.externalEnabled() !== external;
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
    void this.fetchTrending(this.state.filter(), w).then((rows) => {
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
   *  the content area to the results grid. */
  async applyDiscover() {
    const filter = this.state.filter();
    const opts: DiscoverFilters = {
      genreIds: [...this.state.discoverSelectedGenres()],
      sort: this.state.discoverSort(),
      voteMin: this.state.discoverVoteMin() || undefined,
      yearMin: this.state.discoverYearMin(),
      yearMax: this.state.discoverYearMax(),
    };
    this.state.discoverActive.set(true);
    this.state.discoverLoading.set(true);
    this.closeFilterSheet();
    try {
      const rows =
        filter === 'series'
          ? await this.metadata.discoverTv(opts)
          : await this.metadata.discoverMovies(opts);
      this.state.discoverResults.set(rows);
      this.loadRequestedIds();
    } catch {
      this.state.discoverResults.set([]);
    } finally {
      this.state.discoverLoading.set(false);
    }
  }

  clearDiscover() {
    this.state.resetDiscover();
  }

  openFilterSheet() {
    this.filterSheet()?.nativeElement.showModal();
  }

  closeFilterSheet() {
    this.filterSheet()?.nativeElement.close();
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
    if (!q) return;

    const filter = this.state.filter();

    // People search is a distinct surface — no local/external media lookups.
    if (filter === 'people') {
      this.state.peopleLoading.set(true);
      try {
        const results = await this.social.searchUsers(q);
        // Ignore a stale response if the query/filter moved on meanwhile.
        if (this.state.query().trim() !== q || this.state.filter() !== 'people') return;
        this.state.peopleResults.set(results);
      } catch {
        if (this.state.query().trim() === q && this.state.filter() === 'people') {
          this.state.peopleResults.set([]);
        }
      } finally {
        this.state.peopleLoading.set(false);
      }
      return;
    }

    const type: MediaType | undefined = filter === 'all' ? undefined : filter;

    // Search local library first
    this.state.localLoading.set(true);
    const localParams = { q, type, limit: 20, sortBy: 'title' } as const;
    try {
      const res = await this.mediaService.getAll(localParams);
      this.state.localResults.set(res.data);
    } catch {
      this.state.localResults.set([]);
    } finally {
      this.state.localLoading.set(false);
    }
    queueMicrotask(() => {
      // Revalidate: cached result paints instantly, then catch up to fresh
      // matches (a media imported since the last identical query lands here).
      if (this.state.query().trim() !== q || this.state.filter() !== filter) return;
      void this.mediaService
        .getAll(localParams, { force: true })
        .then((fresh) => {
          if (this.state.query().trim() === q && this.state.filter() === filter) {
            this.state.localResults.set(fresh.data);
          }
        })
        .catch(() => { /* keep cached results */ });
    });

    // Then search external providers (if enabled)
    if (!this.state.externalEnabled()) return;
    this.state.externalLoading.set(true);
    try {
      let rows: MetadataSearchResult[];
      if (filter === 'movie') {
        rows = await this.metadata.searchMovie(q);
      } else if (filter === 'series') {
        rows = await this.metadata.searchTv(q);
      } else {
        const [movies, tv] = await Promise.all([
          this.metadata.searchMovie(q),
          this.metadata.searchTv(q),
        ]);
        rows = [...movies, ...tv].sort((a, b) => b.rating - a.rating);
      }
      this.state.externalResults.set(rows);
      this.loadRequestedIds();
    } catch {
      this.state.externalResults.set([]);
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
