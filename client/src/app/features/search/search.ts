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
import { BooksApiService } from '../../core/services/api/books-api.service';
import { AudioPlayerService } from '../../core/services/audio-player/audio-player.service';
import type { CardAction } from '../../core/services/card-actions.service';
import { StreamingApiService, RecommendationItem } from '../../core/services/api/streaming-api.service';
import {
  MetadataService,
  MetadataSearchResult,
  RecordingHit,
  SearchHit,
  DiscoverFilters,
  searchResultKey,
} from '../../core/services/api/metadata.service';
import { AuthService } from '../../core/services/auth.service';
import { SearchStateService, type SearchScope } from '../../core/services/search-state.service';
import { SocialApiService } from '../../core/services/api/social-api.service';
import { TvService } from '../../core/services/tv.service';
import { DeviceService } from '../../core/services/device.service';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { keepRouteFresh } from '../../core/services/keep-route-fresh';
import { MediaCardComponent, CardBadge, SEARCH_CARD_CONTEXT } from '../../shared/components/media-card/media-card';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';
import { NgTemplateOutlet } from '@angular/common';
import { ModalHeaderComponent } from '../../shared/components/modal-header';
import { SearchFiltersComponent, libraryFilterParams } from '../../shared/components/search-filters/search-filters';
import { LucideSearch, LucideX, LucideSettings, LucideMusic } from '@lucide/angular';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../shared/directives/cached-src.directive';
import { Capacitor } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';
import { UserAvatarComponent } from '../../shared/components/user-avatar/user-avatar';
import { AddDialogComponent } from '../../shared/components/add-dialog/add-dialog';
import type { AddRequest, AddResult } from '../../shared/components/add-dialog/add-plan';
import { TrackLineComponent } from '../music/track-line.component';
import { MusicDownloadsService } from '../../core/services/music-downloads.service';
import { HitStateComponent } from './hit-state/hit-state';
import { musicItems, topResult, type MusicItem, type MusicItems, type RowState } from './music-rows';
import { SearchRunner, SOURCES } from './search-runner';
import { canMarkWatched, kindOfListFilter, mediaDetailLink, kindOf } from '../../core/media-kinds';
import type { MediaType } from '../../core/enums/media-type.enum';

const DEBOUNCE_MS = 250;

/** The scopes the filter panel (genre, year, rating, sort) narrows. */
const hasFilters = (s: SearchScope) => s === 'video' || s === 'movie' || s === 'series';
/** The video kind of the discovery rows and TMDB discover; `all` is movies and series, null for no rows. */
const discoveryKind = (s: SearchScope): 'all' | MediaType | null =>
  s === 'all' || s === 'video' ? 'all' : s === 'movie' || s === 'series' ? s : null;

@Component({
  selector: 'app-search',
  imports: [TranslatePluralPipe, AddDialogComponent, TrackLineComponent, DefaultFocusDirective, UserAvatarComponent, FormsModule, TranslatePipe, RouterLink, NgTemplateOutlet, MediaCardComponent, HorizontalScrollerComponent, LucideSearch, LucideX, LucideSettings, LucideMusic, HitStateComponent, ResolveUrlPipe, CachedSrcDirective, ModalHeaderComponent, SearchFiltersComponent],
  templateUrl: './search.html',
  providers: [{ provide: SEARCH_CARD_CONTEXT, useValue: true }],
})
export class SearchComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly mediaService = inject(MediaService);
  private readonly metadata = inject(MetadataService);
  private readonly booksApi = inject(BooksApiService);
  private readonly musicApi = inject(MusicApiService);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly social = inject(SocialApiService);
  protected readonly resultKey = searchResultKey;
  private readonly scrollMemory = inject(ScrollMemoryService);
  private readonly injector = inject(Injector);
  private readonly streamingApi = inject(StreamingApiService);
  readonly tv = inject(TvService);
  /** Members are a scope off TV and while the social layer is on. */
  protected readonly showPeople = computed(() => !this.tv.isTv() && !this.auth.sharingDisabled());
  private readonly device = inject(DeviceService);
  readonly state = inject(SearchStateService);
  private readonly player = inject(AudioPlayerService);
  private readonly downloads = inject(MusicDownloadsService);
  private readonly addDialog = viewChild(AddDialogComponent);
  private readonly runner = new SearchRunner({
    state: this.state,
    media: this.mediaService,
    metadata: this.metadata,
    music: this.musicApi,
    books: this.booksApi,
    social: this.social,
  });

  readonly filterSheet = viewChild<ElementRef<HTMLDialogElement>>('filterSheet');
  private lastDiscoveryKey = '';
  /** Load discovery rows whenever the empty state is showing, keyed on the
   *  video kind + external-search toggle so a change of either refreshes them. */
  private readonly discoveryEffect = effect(() => {
    const ct = discoveryKind(this.state.scope());
    const external = this.state.externalEnabled();
    if (this.state.hasQuery() || ct == null) return;
    const key = `${ct}:${external}`;
    if (key === this.lastDiscoveryKey) return;
    this.lastDiscoveryKey = key;
    void this.loadDiscovery(ct, external);
  });

  private musicTrendingLoading = false;
  private readonly musicTrendingEffect = effect(() => {
    if (!this.isMusic() || this.state.hasQuery() || !this.state.externalEnabled() || this.state.musicTrending()) return;
    untracked(() => void this.loadMusicTrending());
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
    this.state.scope();
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
      if (!hasFilters(this.state.scope())) return;
      if (this.filterDebounce) clearTimeout(this.filterDebounce);
      this.filterDebounce = setTimeout(() => void this.applyFiltersNow(), 300);
    });
  });

  /** Apply filters to the right source: text query → local library; filters → TMDB /discover (external on) or local browse; none → discovery rows. */
  private async applyFiltersNow(): Promise<void> {
    const ct = this.state.scope();
    if (!hasFilters(ct)) return;
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
    if (this.state.scope() === 'people' && !this.showPeople()) this.state.scope.set('all');
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
    // People keeps searching on an empty query (the default roster); the others clear.
    if (value.trim() || this.state.scope() === 'people') {
      this.searchTimer = setTimeout(() => this.runSearch(), DEBOUNCE_MS);
    } else {
      this.runner.cancel();
      this.state.clearResults();
      // An engaged filter keeps browsing (discover / local) with no text query.
      if (this.filterDebounce) clearTimeout(this.filterDebounce);
      void this.applyFiltersNow();
    }
  }

  protected readonly scopes = computed(() => [
    { value: 'all' as const, labelKey: 'search.filter_all' },
    { value: 'video' as const, labelKey: 'search.scope_video' },
    { value: 'book' as const, labelKey: 'books_search.filter_books' },
    { value: 'music' as const, labelKey: 'search.filter_music' },
    ...(this.showPeople() ? [{ value: 'people' as const, labelKey: 'search.scope_people' }] : []),
  ]);
  protected readonly videoKinds = [
    { value: 'video' as const, labelKey: 'search.kind_all' },
    { value: 'movie' as const, labelKey: 'search.filter_movies' },
    { value: 'series' as const, labelKey: 'search.filter_series' },
  ];
  protected readonly musicKinds = [
    { value: 'music' as const, labelKey: 'search.kind_all' },
    { value: 'music-tracks' as const, labelKey: 'music.tab_tracks' },
    { value: 'music-artists' as const, labelKey: 'music.section_artists' },
    { value: 'music-albums' as const, labelKey: 'music.group_album' },
  ];
  protected readonly isVideo = computed(() => hasFilters(this.state.scope()));
  protected readonly isMusic = computed(() => this.state.scope().startsWith('music'));
  /** Several kinds share the grid: the cards carry a type badge. */
  protected readonly mixed = computed(() => this.state.scope() === 'all' || this.state.scope() === 'video');

  protected scopeActive(value: SearchScope): boolean {
    if (value === 'video') return this.isVideo();
    if (value === 'music') return this.isMusic();
    return this.state.scope() === value;
  }

  setScope(s: SearchScope) {
    if (s === 'people' && !this.showPeople()) s = 'all';
    if (s === this.state.scope()) return;
    // Genre ids differ between movies and series, and the other scopes take no filter.
    this.state.resetDiscover();
    this.state.scope.set(s);
    if (s === 'people' || this.state.query().trim()) {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.runSearch();
    }
  }

  /** "Show more" of the members block: the focus moves to the Members scope it opens. */
  protected showAllPeople() {
    this.setScope('people');
    setTimeout(() => document.querySelector<HTMLElement>('[data-scope="people"]')?.focus(), 0);
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

  private async loadMusicTrending(): Promise<void> {
    if (this.musicTrendingLoading) return;
    this.musicTrendingLoading = true;
    const [albums, artists, recordings] = await Promise.all([
      this.metadata.trendingMusic('album').catch(() => []),
      this.metadata.trendingMusic('artist').catch(() => []),
      this.metadata.trendingMusic('recording').catch(() => []),
    ]);
    this.state.musicTrending.set({ albums, artists, recordings });
    this.musicTrendingLoading = false;
  }

  /** What the scope asks, so a section it does not ask never shows a skeleton. */
  private readonly asked = computed(() => SOURCES[this.state.scope()]);
  protected readonly asksTracks = computed(() => this.asked().local.includes('tracks') || this.asked().provider.includes('recording'));
  protected readonly asksAlbums = computed(() => this.asked().local.includes('media') || this.asked().provider.includes('album'));
  protected readonly asksArtists = computed(() => this.asked().local.includes('artists') || this.asked().provider.includes('artist'));

  /** Rows asked and not yet confirmed by the server show their state at once. */
  private readonly optimistic = signal<ReadonlyMap<string, RowState>>(new Map());

  /** The music results of a query, else the trends: one list of library entries and provider hits. */
  protected readonly music = computed<MusicItems>(() => {
    const st = this.state;
    const none = { tracks: [], albums: [], artists: [] };
    let items: MusicItems;
    if (st.hasQuery()) {
      items = musicItems({
        localTracks: st.localTracks(), recordings: st.recordingHits(), localAlbums: st.localResults().filter((m) => m.type === 'album'),
        albumHits: st.albumHits(), localArtists: st.localArtists(), artistHits: st.artistHits(),
      });
    } else {
      const t = st.musicTrending();
      if (!t) return none;
      items = musicItems({
        localTracks: [], recordings: this.asksTracks() ? t.recordings : [], localAlbums: [],
        albumHits: this.asksAlbums() ? t.albums : [], localArtists: [], artistHits: this.asksArtists() ? t.artists : [],
      });
    }
    const ov = this.optimistic();
    if (!ov.size) return items;
    const apply = (rows: MusicItem[]) => rows.map((i) => (ov.has(i.key) ? { ...i, state: ov.get(i.key)! } : i));
    return { tracks: apply(items.tracks), albums: apply(items.albums), artists: apply(items.artists) };
  });
  protected readonly showTop = computed(() => this.state.hasQuery() && (this.state.scope() === 'music' || this.state.scope() === 'all'));
  protected readonly topItem = computed(() => (this.showTop() ? topResult(this.state.query(), this.music()) : null));
  /** The track rows below the top result; the music tab lists a first page, a kind tab all of them. */
  protected readonly titleRows = computed(() => {
    const rows = this.music().tracks.filter((i) => i.key !== this.topItem()?.key);
    return this.state.scope() === 'music' || this.state.scope() === 'all' ? rows.slice(0, this.titlesCap) : this.visible(rows, 'tracks');
  });
  protected readonly titlesMore = computed(() => this.music().tracks.length - (this.topItem()?.kind === 'track' ? 1 : 0) > this.titlesCap);
  protected readonly albumRows = computed(() => this.music().albums.filter((i) => i.key !== this.topItem()?.key));
  protected readonly artistRows = computed(() => this.music().artists.filter((i) => i.key !== this.topItem()?.key));
  protected readonly titlesCap = 5;
  /** Sources asked and not answered yet; the trends until they load. */
  protected readonly musicLoading = computed(() => (this.state.hasQuery() ? this.state.pending().size > 0 : this.state.musicTrending() == null));
  protected readonly musicEmpty = computed(() => {
    const m = this.music();
    return !this.musicLoading() && !m.tracks.length && !m.albums.length && !m.artists.length;
  });
  protected readonly catalogDown = computed(() => (['album', 'artist', 'recording'] as const).some((k) => this.state.failed().has(k)));

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
      discoveryKind(this.state.scope()) !== ct ||
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
    const ct = discoveryKind(this.state.scope());
    if (ct == null) return;
    void this.fetchTrending(ct, w).then((rows) => {
      if (this.state.trendingWindow() === w) this.state.discoveryTrending.set(rows);
    });
  }

  /** Run the TMDB /discover query from the panel filters and show the results grid; stale responses are dropped. */
  async applyDiscover() {
    const scope = this.state.scope();
    const ct = discoveryKind(scope) ?? 'all';
    const sig = (this.lastDiscoverSig = this.filterSig('', scope));
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
    this.state.resetDiscover();
    this.state.scope.set('video');
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
    const kind = discoveryKind(this.state.scope());
    if (!hasFilters(this.state.scope()) || kind == null) return;
    const type = kindOfListFilter(kind);
    if (type === this.lastGenreType && this.state.discoverGenres().length) return;
    this.lastGenreType = type;
    const stale = () => {
      const k = discoveryKind(this.state.scope());
      return !hasFilters(this.state.scope()) || k == null || kindOfListFilter(k) !== type;
    };
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
    const scope = this.state.scope();
    // Members search on an empty query too: the server then returns the default roster.
    if (!q && scope !== 'people') return;
    if (hasFilters(scope) && this.state.discoverSelectedGenres().size) await this.ensureDiscoverGenres();
    else void this.ensureDiscoverGenres();
    this.lastLocalSig = this.filterSig(q, scope);
    this.more.set(new Set());
    this.runner.run(q, scope, { external: this.state.externalEnabled(), people: this.showPeople(), mediaParams: this.mediaParams(scope) });
  }

  /** The library query of the discover panel filters: text, genres, year, rating and sort. */
  private mediaParams(scope: SearchScope): SearchParams {
    return libraryFilterParams({
      type: SOURCES[scope].types ?? 'all',
      genreNames: this.state.selectedGenreNames(),
      sort: this.state.discoverSort(),
      voteMin: this.state.discoverVoteMin(),
      yearMin: this.state.discoverYearMin(),
      yearMax: this.state.discoverYearMax(),
    });
  }

  /** Re-runs the library media alone after a filter change; the provider hits re-filter in the state. */
  private async runLocalSearch(q: string, ct: SearchScope) {
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
  /** Library titles of the grid: albums belong to the music results. */
  protected readonly libraryMedia = computed(() => this.state.localResults().filter((m) => m.type !== 'album'));
  private readonly musicCount = computed(() => {
    const m = this.music();
    return m.tracks.length + m.albums.length + m.artists.length;
  });
  /** The filter panel (genre, year, rating, sort) narrows videos; books and music have none. */
  protected readonly showFilters = this.isVideo;
  protected readonly libraryCount = computed(
    () => this.libraryMedia().length + this.videoHeld().length + this.booksHeld().length + this.state.localAuthors().length + this.state.localSeries().length,
  );
  protected readonly providerCount = computed(() => this.videoToAdd().length + this.booksToAdd().length);

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

  /** `release` replaces the hit's id: a recording names its own release, which is the album to add. */
  protected add(row: SearchHit, recording?: RecordingHit, release?: string): void {
    const externalId = release ?? row.externalId;
    const req: AddRequest = {
      kind: row.mediaType,
      provider: row.provider,
      externalId,
      title: row.title,
      ...(recording ? { recording: { externalId: recording.externalId, albumExternalId: externalId } } : {}),
    };
    this.pendingAdd = { row, recording };
    void this.addDialog()?.add(req);
  }

  private pendingAdd: { row: SearchHit; recording?: RecordingHit; key?: string } | null = null;

  /** The row flips to pending at once; a cancelled or failed add puts it back. */
  protected addItem(i: MusicItem): void {
    const row = i.recording?.album ?? i.album;
    if (!row) return;
    this.optimistic.update((m) => new Map(m).set(i.key, 'pending'));
    this.add(row, i.recording, i.recording?.release?.externalId);
    this.pendingAdd!.key = i.key;
  }

  protected onCancelled(): void {
    const key = this.pendingAdd?.key;
    this.pendingAdd = null;
    if (key) this.optimistic.update((m) => new Map([...m].filter(([k]) => k !== key)));
  }

  /** The cards flip to their new state without another search. */
  protected onAdded(r: AddResult): void {
    const hit = this.pendingAdd;
    if (!hit) return;
    this.pendingAdd = null;
    const patch = (albums: (rows: SearchHit[]) => SearchHit[], recs: (rows: RecordingHit[]) => RecordingHit[]) => {
      this.state.albumHits.update(albums);
      this.state.recordingHits.update(recs);
      this.state.musicTrending.update((t) => t && { ...t, albums: albums(t.albums), recordings: recs(t.recordings) });
    };
    if (r.recordings) {
      const asked = new Set(r.recordings);
      patch((rows) => rows, (rows) =>
        rows.map((x) => {
          if (!asked.has(x.externalId)) return x;
          if (r.mode === 'request') return { ...x, requestStatus: 'pending' as const };
          return x.existingMediaId == null ? { ...x, existingMediaId: r.mediaId, state: 'wanted' as const } : x;
        }),
      );
    } else {
      const next: SearchHit = {
        ...hit.row,
        existingMediaId: r.mediaId ?? hit.row.existingMediaId,
        state: r.mode === 'import' ? 'wanted' : hit.row.state,
        requestStatus: r.mode === 'request' ? 'pending' : hit.row.requestStatus,
      };
      const swap = (rows: SearchHit[]) => rows.map((x) => (x === hit.row ? next : x));
      for (const list of [this.state.movieHits, this.state.seriesHits, this.state.bookHits]) list.update(swap);
      const wanted = r.mode === 'import' && r.mediaId != null;
      patch(swap, (rows) =>
        rows.map((x) =>
          x.album !== hit.row
            ? x
            : {
                ...x,
                album: next,
                ...(r.mode === 'request' ? { requestStatus: 'pending' as const } : {}),
                ...(wanted && x.existingMediaId == null ? { existingMediaId: r.mediaId, state: 'wanted' as const } : {}),
              },
        ),
      );
    }
    if (hit.key) this.optimistic.update((m) => new Map([...m].filter(([k]) => k !== hit.key)));
  }

  // ── Artists, albums and tracks ──

  /** A provider artist opens through the library person holding it, created on the first click. */
  private async openArtist(i: MusicItem): Promise<void> {
    try {
      const id = i.personId ?? (await this.musicApi.resolveArtist({ provider: i.artist!.provider, externalId: i.artist!.externalId })).id;
      void this.router.navigate(['/artists', id]);
    } catch {
      /* the global error toast says why */
    }
  }

  /** An artist opens its page, an album its library page or add preview, a track the album queue from it when owned. */
  protected async openItem(i: MusicItem): Promise<void> {
    if (i.kind === 'artist') return this.openArtist(i);
    if (i.kind === 'track' && i.state === 'owned' && i.mediaId != null && i.itemId != null) {
      try {
        const queue = await this.downloads.albumTracks(i.mediaId);
        const at = queue.findIndex((t) => t.itemId === i.itemId);
        if (at >= 0) return await this.player.playTracks(queue, at);
      } catch {
        return; // the global error toast says why
      }
    }
    void this.openAlbum(i);
  }

  /** The album page scrolls to the track named in `track`: its library item id, else its provider recording id. */
  private openAlbum(i: MusicItem): Promise<boolean> {
    const hit = i.recording?.album ?? i.album;
    const queryParams = i.kind === 'track' ? { track: i.itemId ?? i.recording?.externalId } : undefined;
    const route =
      i.mediaId != null
        ? mediaDetailLink('album', i.mediaId)
        : ['/add/album', hit!.provider, i.recording?.release?.externalId ?? hit!.externalId];
    return this.router.navigate(route, { queryParams });
  }

  protected readonly placeholders = [0, 1, 2, 3, 4, 5];
  protected readonly peopleCap = 4;

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
