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
import { MediaService, Media, GenreSummary } from '../../core/services/api/media.service';
import { StreamingApiService, RecommendationItem } from '../../core/services/api/streaming-api.service';
import { LibrariesApiService } from '../../core/services/api/libraries-api.service';
import {
  MetadataService,
  MetadataSearchResult,
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
import { MosaicCardComponent } from '../../shared/components/mosaic-card/mosaic-card';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';
import { DropdownMenuComponent } from '../../shared/components/dropdown-menu';
import { LucideSearch, LucideX, LucideSettings } from '@lucide/angular';
import { Capacitor } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';

@Component({
  selector: 'app-search',
  imports: [FormsModule, TranslateModule, RouterLink, MediaCardComponent, MosaicCardComponent, HorizontalScrollerComponent, DropdownMenuComponent, LucideSearch, LucideX, LucideSettings],
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
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly social = inject(SocialApiService);
  readonly tv = inject(TvService);
  readonly state = inject(SearchStateService);

  /** First accessible library — genre tiles deep-link into it filtered by genre. */
  readonly firstLibraryName = signal('');
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
    void this.loadLibraries();

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

  private async loadLibraries(): Promise<void> {
    try {
      const libs = await this.librariesApi.list();
      this.firstLibraryName.set(libs[0]?.name ?? '');
    } catch {
      /* interceptor surfaces errors */
    }
  }

  /**
   * Populate the empty-state discovery rows. Trending/popular come from the
   * external providers and are only fetched when external search is enabled;
   * suggestions + genres always come from the viewer's own libraries. Each
   * fetch fails soft (empty row) so a missing provider / cold-start user just
   * hides that section. Rows follow the active `movie`/`series`/`all` tab.
   */
  private async loadDiscovery(
    filter: 'all' | 'movie' | 'series' | 'people',
    external: boolean,
  ): Promise<void> {
    this.state.discoveryLoading.set(true);
    try {
      const isSeries = filter === 'series';
      const isMovie = filter === 'movie';

      const [recs, genres] = await Promise.all([
        this.streamingApi.getRecommendations({ limit: 30 }).catch(() => []),
        this.mediaService.getGenres().catch(() => [] as GenreSummary[]),
      ]);
      if (this.staleDiscovery(filter, external)) return;
      this.state.discoveryRecommendations.set(
        isMovie || isSeries
          ? recs.filter((r) => r.media.type === (isMovie ? 'movie' : 'series'))
          : recs,
      );
      this.state.discoveryGenres.set(genres);

      if (!external) {
        this.state.discoveryTrending.set([]);
        this.state.discoveryPopular.set([]);
        return;
      }
      const [trending, popular] = await Promise.all([
        isSeries
          ? this.metadata.getTrendingTv().catch(() => [])
          : isMovie
            ? this.metadata.getTrendingMovies().catch(() => [])
            : Promise.all([
                this.metadata.getTrendingMovies().catch(() => []),
                this.metadata.getTrendingTv().catch(() => []),
              ]).then(([m, t]) => this.interleave(m, t)),
        isSeries
          ? this.metadata.getPopularTv().catch(() => [])
          : isMovie
            ? this.metadata.getPopularMovies().catch(() => [])
            : Promise.all([
                this.metadata.getPopularMovies().catch(() => []),
                this.metadata.getPopularTv().catch(() => []),
              ]).then(([m, t]) => this.interleave(m, t)),
      ]);
      if (this.staleDiscovery(filter, external)) return;
      this.state.discoveryTrending.set(trending);
      this.state.discoveryPopular.set(popular);
      this.loadRequestedIds();
    } finally {
      this.state.discoveryLoading.set(false);
    }
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

  openGenre(genre: string) {
    const lib = this.firstLibraryName();
    if (!lib) return;
    void this.router.navigate(['/libraries', lib], {
      queryParams: { view: 'all', genre },
    });
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
