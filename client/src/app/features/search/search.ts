import {
  Component,
  signal,
  computed,
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
import { DefaultFocusDirective } from '../../shared/directives/default-focus.directive';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { TranslatePluralPipe } from '../../core/pipes/translate-plural.pipe';
import { MediaService, Media, SearchParams } from '../../core/services/api/media.service';
import { MusicApiService } from '../../core/services/api/music-api.service';
import type { TrackRow } from '../../core/services/api/music.models';
import { BooksApiService } from '../../core/services/api/books-api.service';
import { AudioPlayerService } from '../../core/services/audio-player/audio-player.service';
import type { CardAction } from '../../core/services/card-actions.service';
import { StreamingApiService, RecommendationItem } from '../../core/services/api/streaming-api.service';
import {
  MetadataService,
  MetadataSearchResult,
  ArtistHit,
  RecordingHit,
  SearchHit,
  DiscoverFilters,
  searchResultKey,
} from '../../core/services/api/metadata.service';
import { AuthService } from '../../core/services/auth.service';
import { SearchStateService } from '../../core/services/search-state.service';
import { SocialApiService } from '../../core/services/api/social-api.service';
import { TvService } from '../../core/services/tv.service';
import { DeviceService } from '../../core/services/device.service';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { keepRouteFresh } from '../../core/services/keep-route-fresh';
import { MediaCardComponent, CardBadge, SEARCH_CARD_CONTEXT } from '../../shared/components/media-card/media-card';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';
import { DropdownMenuComponent } from '../../shared/components/dropdown-menu';
import { NgTemplateOutlet } from '@angular/common';
import { ModalHeaderComponent } from '../../shared/components/modal-header';
import { SearchFiltersComponent, libraryFilterParams } from '../../shared/components/search-filters/search-filters';
import { ContentTypeToggleComponent } from '../../shared/components/search-filters/content-type-toggle';
import { LucideSearch, LucideX, LucideSettings, LucidePlay } from '@lucide/angular';
import { Capacitor } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';
import { UserAvatarComponent } from '../../shared/components/user-avatar/user-avatar';
import { AddDialogComponent } from '../../shared/components/add-dialog/add-dialog';
import type { AddRequest, AddResult } from '../../shared/components/add-dialog/add-plan';
import { TrackLineComponent } from '../music/track-line.component';
import { artistLine, toTrackRequest } from '../music/music-utils';
import { SearchRunner } from './search-runner';
import { canMarkWatched, kindOfListFilter, mediaDetailLink, kindOf } from '../../core/media-kinds';
import type { MediaType } from '../../core/enums/media-type.enum';

/** The content types searched as shelves of their own (library, people and providers), not through the video flow. */
const DEBOUNCE_MS = 250;

/** The content types without discovery rows or filter panel: their search is the shelves of the results. */
const isShelf = (ct: 'all' | MediaType) => ct === 'book' || ct === 'album';

@Component({
  selector: 'app-search',
  imports: [TranslatePluralPipe, AddDialogComponent, TrackLineComponent, DefaultFocusDirective, UserAvatarComponent, FormsModule, TranslatePipe, RouterLink, NgTemplateOutlet, MediaCardComponent, HorizontalScrollerComponent, DropdownMenuComponent, LucideSearch, LucideX, LucideSettings, LucidePlay, ModalHeaderComponent, SearchFiltersComponent, ContentTypeToggleComponent],
  templateUrl: './search.html',
  providers: [{ provide: SEARCH_CARD_CONTEXT, useValue: true }],
})
export class SearchComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly mediaService = inject(MediaService);
  private readonly metadata = inject(MetadataService);
  private readonly booksApi = inject(BooksApiService);
  private readonly music = inject(MusicApiService);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  /** Opted out of the social layer → the people tab is hidden. */
  protected readonly resultKey = searchResultKey;
  protected readonly sharingDisabled = this.auth.sharingDisabled;
  private readonly scrollMemory = inject(ScrollMemoryService);
  private readonly injector = inject(Injector);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly social = inject(SocialApiService);
  readonly tv = inject(TvService);
  private readonly device = inject(DeviceService);
  readonly state = inject(SearchStateService);
  private readonly player = inject(AudioPlayerService);
  private readonly addDialog = viewChild(AddDialogComponent);
  private readonly runner = new SearchRunner({
    state: this.state,
    media: this.mediaService,
    metadata: this.metadata,
    music: this.music,
    books: this.booksApi,
  });

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

  /** Refocus the input on an external request (e.g. dock search re-tap), selecting the text so it can be overwritten. */
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

  /** Preload the discover panel with a genre requested from elsewhere (profile taste chip); instance-level so it fires across route reuse. */
  private readonly genreFilterEffect = effect(() => {
    const req = this.state.genreFilterRequest();
    if (!req) return;
    // One-shot: untracked so the applied filter reads don't become deps.
    untracked(() => {
      void this.applyGenreFilter(req.genreId);
      this.state.genreFilterRequest.set(null);
    });
  });

  /** Keep the discover genre list populated for the active type (movie genres for "all"/"movie", TV list for series) so chips render during text search. */
  private readonly discoverGenreEffect = effect(() => {
    this.state.tab();
    this.state.contentType();
    this.state.externalEnabled();
    untracked(() => void this.ensureDiscoverGenres());
  });

  /** Auto-apply discover filters (debounced); untracked so its writes don't feed back. See applyFiltersNow. */
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

  /** Apply filters to the right source: text query → local library; filters → TMDB /discover (external on) or local browse; none → discovery rows. */
  private async applyFiltersNow(): Promise<void> {
    if (this.state.tab() !== 'videos') return;
    const ct = this.state.contentType();
    if (isShelf(ct)) return;
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

  private static readonly SCROLL_KEY = 'search';
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private filterDebounce: ReturnType<typeof setTimeout> | null = null;
  /** Movie/series bucket the discover genre list was last loaded for. */
  private lastGenreType = '';
  /** Cached route, with nothing to refetch: results live in SearchStateService,
   *  so only the scroll key has to change hands. */
  private readonly routeFresh = keepRouteFresh({
    scrollKey: SearchComponent.SCROLL_KEY,
  });

  ngOnInit() {
    this.scrollMemory.activate(SearchComponent.SCROLL_KEY);
    this.scrollMemory.restore(SearchComponent.SCROLL_KEY, this.injector);
  }

  ngAfterViewInit() {
    // Auto-focus only on non-touch: on touch it would pop the soft keyboard; there only a dock re-tap (requestFocus) opens it.
    if (!this.state.hasQuery() && !this.device.isTouch()) {
      setTimeout(() => this.searchInput()?.nativeElement.focus(), 100);
    }
  }

  ngOnDestroy() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (this.filterDebounce) clearTimeout(this.filterDebounce);
    this.scrollMemory.deactivateIf(SearchComponent.SCROLL_KEY);
    this.removeOutsidePointerListener();
  }

  /** Outside-tap → blur: Capacitor's iOS WebView doesn't reliably blur on a non-interactive tap, so a one-shot pointerdown listener does. */
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

  onQueryInput(value: string) {
    this.state.query.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    // People keeps searching on an empty query (→ default roster); videos clear.
    if (value.trim() || this.state.tab() === 'people') {
      this.searchTimer = setTimeout(() => this.runSearch(), DEBOUNCE_MS);
    } else {
      this.runner.cancel();
      this.state.clearResults();
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

  setContentType(ct: 'all' | MediaType) {
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
    if (this.state.query().trim()) {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.runSearch();
    } else {
      // Discover mode: switch the filter source (TMDB /discover ↔ local browse).
      if (this.filterDebounce) clearTimeout(this.filterDebounce);
      void this.applyFiltersNow();
    }
  }

  clearQuery() {
    this.runner.cancel();
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

  /** Populate the empty-state discovery rows; TMDB rows need external search, suggestions come from the library, and each fetch fails soft. */
  private async loadDiscovery(
    ct: 'all' | MediaType,
    external: boolean,
  ): Promise<void> {
    if (isShelf(ct)) return;
    this.state.discoveryLoading.set(true);
    try {

      const recs = await this.streamingApi
        .getRecommendations({ limit: 30 })
        .catch(() => []);
      if (this.staleDiscovery(ct, external)) return;
      this.state.discoveryRecommendations.set(
        ct === 'all' ? recs : recs.filter((r) => r.media.type === ct),
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
        this.metadata.genresByKind(kindOfListFilter(ct)).catch(
          () => [],
        ),
      ]);
      if (this.staleDiscovery(ct, external)) return;
      this.state.discoveryTrending.set(trending);
      this.state.discoveryPopular.set(popular);
      this.state.discoverGenres.set(genres);

      // "Suggestions pour vous": TMDB catalog matching taste, not library-limited; derive top genres from library recommendations.
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
    ct: 'all' | MediaType,
    genreIds: number[],
  ): Promise<MetadataSearchResult[]> {
    if (!genreIds.length) return [];
    const perGenre = await Promise.all(
      genreIds.map((id) =>
        this.metadata.discoverByKind(kindOfListFilter(ct), { genreIds: [id], sort: 'popularity.desc' }).catch(() => [] as MetadataSearchResult[]),
      ),
    );
    const out: MetadataSearchResult[] = [];
    const seen = new Set<string>();
    const maxLen = Math.max(0, ...perGenre.map((a) => a.length));
    for (let i = 0; i < maxLen; i++) {
      for (const arr of perGenre) {
        const r = arr[i];
        if (r && !seen.has(searchResultKey(r))) {
          seen.add(searchResultKey(r));
          out.push(r);
        }
      }
    }
    return out.slice(0, 24);
  }

  private async fetchTrending(
    ct: 'all' | MediaType,
    window: 'day' | 'week',
  ): Promise<MetadataSearchResult[]> {
    if (ct !== 'all') return this.metadata.trendingByKind(ct, window).catch(() => []);
    const [m, t] = await Promise.all([
      this.metadata.getTrendingMovies(window).catch(() => []),
      this.metadata.getTrendingTv(window).catch(() => []),
    ]);
    return this.interleave(m, t);
  }

  private async fetchPopular(
    ct: 'all' | MediaType,
  ): Promise<MetadataSearchResult[]> {
    if (ct !== 'all') return this.metadata.popularByKind(ct).catch(() => []);
    const [m, t] = await Promise.all([
      this.metadata.getPopularMovies().catch(() => []),
      this.metadata.getPopularTv().catch(() => []),
    ]);
    return this.interleave(m, t);
  }

  /** True if the type/toggle moved on while a discovery fetch was in flight. */
  private staleDiscovery(
    ct: 'all' | MediaType,
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
    return mediaDetailLink(rec.media.type, rec.media.id);
  }

  // ── Discover panel ──

  setTrendingWindow(w: 'day' | 'week') {
    if (this.state.trendingWindow() === w) return;
    this.state.trendingWindow.set(w);
    void this.fetchTrending(this.state.contentType(), w).then((rows) => {
      if (this.state.trendingWindow() === w) this.state.discoveryTrending.set(rows);
    });
  }

  /** Run the TMDB /discover query from the panel filters and show the results grid; stale responses are dropped. */
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
      const rows = await this.metadata.discoverByKind(kindOfListFilter(ct), opts);
      if (fresh()) {
        this.state.discoverResults.set(rows);
      }
    } catch {
      if (fresh()) this.state.discoverResults.set([]);
    } finally {
      if (fresh()) this.state.discoverLoading.set(false);
    }
  }
  private lastDiscoverSig = '';

  /** Preload the discover panel on a caller-resolved genre id (language-proof); liveFilterEffect auto-applies it. */
  private applyGenreFilter(genreId: number): void {
    this.state.tab.set('videos');
    this.state.query.set('');
    this.state.discoverSelectedGenres.set(new Set([genreId]));
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
    if (this.state.tab() !== 'videos' || isShelf(this.state.contentType())) return;
    const type = kindOfListFilter(this.state.contentType());
    if (type === this.lastGenreType && this.state.discoverGenres().length) return;
    this.lastGenreType = type;
    const stale = () =>
      this.state.tab() !== 'videos' ||
      kindOfListFilter(this.state.contentType()) !== type;
    try {
      const genres = await this.metadata.genresByKind(type);
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
    return canMarkWatched(m);
  }

  async toggleMediaWatched(m: Media, watched: boolean) {
    try {
      if (kindOf(m.type).hasSeasons) {
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
    if (this.state.discoverSelectedGenres().size) await this.ensureDiscoverGenres();
    else void this.ensureDiscoverGenres();
    this.lastLocalSig = this.filterSig(q, ct);
    this.more.set(new Set());
    this.runner.run(q, ct, { external: this.state.externalEnabled(), mediaParams: this.mediaParams(ct) });
  }

  /** The library query of the discover panel filters: text, genres, year, rating and sort. */
  private mediaParams(ct: 'all' | MediaType): SearchParams {
    return libraryFilterParams({
      type: ct,
      genreNames: this.state.selectedGenreNames(),
      sort: this.state.discoverSort(),
      voteMin: this.state.discoverVoteMin(),
      yearMin: this.state.discoverYearMin(),
      yearMax: this.state.discoverYearMax(),
    });
  }

  /** Re-runs the library media alone after a filter change; the provider hits re-filter in the state. */
  private async runLocalSearch(q: string, ct: 'all' | MediaType) {
    this.lastLocalSig = this.filterSig(q, ct);
    if (this.state.discoverSelectedGenres().size) await this.ensureDiscoverGenres();
    this.runner.runMedia(q, this.mediaParams(ct));
  }

  // ── Cards ──

  protected readonly canAdd = computed(() => this.auth.hasPermission('media.create'));
  protected readonly canRequest = computed(() => !this.canAdd() && this.auth.hasPermission('requests.create'));

  protected readonly videoHeld = this.state.videoHeld;
  protected readonly videoToAdd = this.state.videoToAdd;
  protected readonly booksHeld = this.state.booksHeld;
  protected readonly booksToAdd = this.state.booksToAdd;
  protected readonly albumsHeld = this.state.albumsHeld;
  protected readonly albumsToAdd = this.state.albumsToAdd;
  protected readonly artistsToAdd = this.state.artistsToAdd;
  protected readonly recordingsToAdd = this.state.recordingsToAdd;
  /** The filter panel (genre, year, rating, sort) narrows videos; books and music have none. */
  protected readonly showFilters = computed(() => !isShelf(this.state.contentType()));
  protected readonly libraryCount = computed(
    () =>
      this.state.localResults().length + this.videoHeld().length + this.booksHeld().length + this.albumsHeld().length +
      this.state.localArtists().length + this.state.localTracks().length + this.state.localAuthors().length + this.state.localSeries().length,
  );
  protected readonly providerCount = computed(
    () => this.videoToAdd().length + this.booksToAdd().length + this.albumsToAdd().length + this.artistsToAdd().length + this.recordingsToAdd().length,
  );

  protected albumSubtitle(row: SearchHit): string {
    return [row.artists?.join(', '), row.year].filter(Boolean).join(' \u00b7 ');
  }

  /** What the card of a provider hit says: owned, wanted or missing in the library, else the caller's request. */
  cardStatus(row: SearchHit): CardBadge {
    if (row.state === 'owned') return 'library';
    if (row.state === 'wanted') return 'wanted';
    if (row.state === 'missing') return 'missing';
    switch (row.requestStatus) {
      case 'available':
        return 'library';
      case 'declined':
      case 'failed':
        return 'declined';
      case 'pending':
      case 'approved':
      case 'processing':
        return 'pending';
      default:
        return null;
    }
  }

  /** The hit's page: the library's own for a title it holds, else the add preview. */
  externalLink(row: SearchHit): string[] {
    if (row.existingMediaId) {
      return mediaDetailLink(row.existingMediaType ?? row.mediaType, row.existingMediaId);
    }
    const provider = row.provider ?? 'tmdb';
    const externalId =
      row.externalId ?? (provider === 'tvdb' ? String(row.tvdbId ?? row.tmdbId) : String(row.tmdbId));
    return ['/add/' + kindOf(row.mediaType).providerSegment, provider, externalId];
  }

  /** Add, or Request for a caller who cannot add; none for a hit held already or asked for. */
  hitActions(row: SearchHit): CardAction[] {
    if (row.existingMediaId != null || row.requestStatus === 'pending' || row.requestStatus === 'approved') return [];
    if (!this.canAdd() && !this.canRequest()) return [];
    return [
      {
        labelKey: this.canAdd() ? 'discover.add_to_library' : 'discover.request',
        icon: 'plus',
        run: () => this.add(row),
      },
    ];
  }

  protected add(row: SearchHit, recording?: RecordingHit): void {
    const req: AddRequest = {
      kind: row.mediaType,
      provider: row.provider,
      externalId: row.externalId,
      title: row.title,
      ...(recording ? { recording: { externalId: recording.externalId, albumExternalId: row.externalId } } : {}),
    };
    this.pendingAdd = { row, recording };
    void this.addDialog()?.add(req);
  }

  private pendingAdd: { row: SearchHit; recording?: RecordingHit } | null = null;

  /** The card flips to its new state without another search. */
  protected onAdded(r: AddResult): void {
    const hit = this.pendingAdd;
    if (!hit) return;
    this.pendingAdd = null;
    const next: SearchHit = {
      ...hit.row,
      existingMediaId: r.mediaId ?? hit.row.existingMediaId,
      state: r.mode === 'import' ? 'wanted' : hit.row.state,
      requestStatus: r.mode === 'request' ? 'pending' : hit.row.requestStatus,
    };
    const swap = (rows: SearchHit[]) => rows.map((x) => (x === hit.row ? next : x));
    for (const list of [this.state.movieHits, this.state.seriesHits, this.state.bookHits, this.state.albumHits]) list.update(swap);
    this.state.recordingHits.update((rows) => rows.map((x) => (x.album === hit.row ? { ...x, album: next } : x)));
  }

  protected addRecording(rec: RecordingHit): void {
    this.add(rec.album);
  }

  /** Wants that one track: the album is added with only it monitored. */
  protected wantRecording(rec: RecordingHit): void {
    this.add(rec.album, rec);
  }

  // ── Artists and tracks ──

  /** A provider artist opens through the library person holding it, created on the first click. */
  protected async openArtist(a: ArtistHit): Promise<void> {
    try {
      const id = a.personId ?? (await this.music.resolveArtist({ provider: a.provider, externalId: a.externalId, name: a.name, sortName: a.sortName })).id;
      void this.router.navigate(['/artists', id]);
    } catch {
      /* the global error toast says why */
    }
  }

  protected readonly artistLine = artistLine;

  /** Plays the library tracks of the result from the tapped one. */
  protected playTrack(rows: TrackRow[], index: number): Promise<void> {
    const playable = rows.filter((r) => r.hasFile);
    const start = Math.max(0, playable.indexOf(rows[index]!));
    return this.player.playTracks(
      playable.map((r) =>
        toTrackRequest(r, { mediaId: r.mediaId, title: r.albumTitle, coverUrl: r.posterUrl, artists: '', albumGain: null, albumPeak: null }),
      ),
      start,
    );
  }

  protected readonly placeholders = [0, 1, 2, 3, 4, 5];

  /** Books, albums, artists and tracks of the providers show a first page; the sections below them stay in reach. */
  protected readonly cap = 12;
  protected readonly more = signal<ReadonlySet<string>>(new Set());

  protected visible<T>(rows: T[], section: string): T[] {
    return this.more().has(section) ? rows : rows.slice(0, this.cap);
  }

  protected showMore(section: string): void {
    this.more.update((s) => new Set(s).add(section));
  }
}
