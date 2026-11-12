import { Injectable, signal, computed, effect, type WritableSignal } from '@angular/core';
import { Media } from './api/media.service';
import { ArtistHit, MetadataSearchResult, RecordingHit, SearchHit, TmdbGenre } from './api/metadata.service';
import type { MusicPersonRow, TrackRow } from './api/music.models';
import type { CollectionSummary, PersonListItem } from './api/books.models';
import { RecommendationItem } from './api/streaming-api.service';
import { SocialUser } from './api/social-api.service';
import { DEFAULT_SORT, filtersEngaged } from '../../shared/components/search-filters/search-filters';

const EXTERNAL_KEY = 'fliks-search-external';

/** The type selector: `video` and `music` hold every kind of their group, the others one each. */
export type SearchScope =
  | 'all' | 'video' | 'movie' | 'series' | 'book' | 'music' | 'music-tracks' | 'music-artists' | 'music-albums' | 'people';
const SCOPES: SearchScope[] = ['all', 'video', 'movie', 'series', 'book', 'music', 'music-tracks', 'music-artists', 'music-albums', 'people'];
const SCOPE_KEY = 'fliks-search-scope';

/** What one search asks: the library and the providers, each of its own kinds. */
export type SearchSource =
  | 'media' | 'tracks' | 'artists' | 'authors' | 'series' | 'people'
  | 'movie' | 'tv' | 'book' | 'album' | 'artist' | 'recording';

export const LOCAL_SOURCES: SearchSource[] = ['media', 'tracks', 'artists', 'authors', 'series'];
export const PROVIDER_SOURCES: SearchSource[] = ['movie', 'tv', 'book', 'album', 'artist', 'recording'];

@Injectable({ providedIn: 'root' })
export class SearchStateService {
  readonly query = signal('');
  readonly scope = signal<SearchScope>(SCOPES.find((v) => v === localStorage.getItem(SCOPE_KEY)) ?? 'all');
  readonly externalEnabled = signal(localStorage.getItem(EXTERNAL_KEY) !== 'false');

  private readonly persistExternal = effect(() => {
    localStorage.setItem(EXTERNAL_KEY, String(this.externalEnabled()));
  });
  private readonly persistScope = effect(() => localStorage.setItem(SCOPE_KEY, this.scope()));
  /** The library zone: media rows of every kind, tracks, artists, authors and book series. */
  readonly localResults = signal<Media[]>([]);
  readonly localTracks = signal<TrackRow[]>([]);
  readonly localArtists = signal<MusicPersonRow[]>([]);
  readonly localAuthors = signal<PersonListItem[]>([]);
  readonly localSeries = signal<CollectionSummary[]>([]);
  /** The provider zone, one list per source so each lands on its own. */
  readonly movieHits = signal<SearchHit[]>([]);
  readonly seriesHits = signal<SearchHit[]>([]);
  readonly bookHits = signal<SearchHit[]>([]);
  readonly albumHits = signal<SearchHit[]>([]);
  readonly artistHits = signal<ArtistHit[]>([]);
  readonly recordingHits = signal<RecordingHit[]>([]);
  /** Sources asked and not answered yet, and those that failed or timed out. */
  readonly pending = signal<ReadonlySet<SearchSource>>(new Set());
  readonly failed = signal<ReadonlySet<SearchSource>>(new Set());
  readonly localLoading = computed(() => LOCAL_SOURCES.some((k) => this.pending().has(k)));
  readonly externalLoading = computed(() => PROVIDER_SOURCES.some((k) => this.pending().has(k)));
  readonly externalFailed = computed(() => PROVIDER_SOURCES.some((k) => this.failed().has(k)));
  readonly peopleResults = signal<SocialUser[]>([]);
  readonly hasQuery = computed(() => this.query().trim().length > 0);

  // ── Discovery rows (shown when no query is typed, external search on) ──
  /** Time window for the Tendances row. */
  readonly trendingWindow = signal<'day' | 'week'>('week');
  readonly discoveryTrending = signal<MetadataSearchResult[]>([]);
  readonly discoveryPopular = signal<MetadataSearchResult[]>([]);
  /** Personalized recommendations from the viewer's library (local; used for the
   *  external-OFF row and to derive the taste genres below). */
  readonly discoveryRecommendations = signal<RecommendationItem[]>([]);
  /** TMDB catalog picks matching the viewer's taste — the external-ON
   *  "Suggestions pour vous" row, deliberately NOT limited to the library. */
  readonly discoverySuggestions = signal<MetadataSearchResult[]>([]);
  readonly discoveryLoading = signal(false);
  /** The music provider's weekly trends, loaded once; null until then. */
  readonly musicTrending = signal<{ albums: SearchHit[]; artists: ArtistHit[]; recordings: RecordingHit[] } | null>(null);

  // ── Discover filter panel (TMDB /discover) ──
  /** Genre list for the active tab (movie vs tv). */
  readonly discoverGenres = signal<TmdbGenre[]>([]);
  readonly discoverSelectedGenres = signal<ReadonlySet<number>>(new Set());
  readonly discoverSort = signal(DEFAULT_SORT);
  readonly discoverVoteMin = signal(0);
  readonly discoverYearMin = signal<number | null>(null);
  readonly discoverYearMax = signal<number | null>(null);
  /** Results of an applied discover query. */
  readonly discoverResults = signal<MetadataSearchResult[]>([]);
  readonly discoverLoading = signal(false);
  /** True once a discover query has been applied (rows → results grid). */
  readonly discoverActive = signal(false);

  /** Any narrowing filter (genre/rating/year); sort alone doesn't count. Drives the auto-apply and the Clear button. */
  readonly filtersEngaged = computed(() =>
    filtersEngaged(this.discoverSelectedGenres(), this.discoverVoteMin(), this.discoverYearMin(), this.discoverYearMax()),
  );

  /** Names of the selected discover genres (panel selects TMDB ids; results
   *  carry genre names). Used to post-filter external results by name. */
  readonly selectedGenreNames = computed(() => {
    const selected = this.discoverSelectedGenres();
    return this.discoverGenres()
      .filter((g) => selected.has(g.id))
      .map((g) => g.name);
  });

  /** Reset the discover panel filters + results. */
  resetDiscover(): void {
    this.discoverSelectedGenres.set(new Set());
    this.discoverSort.set(DEFAULT_SORT);
    this.discoverVoteMin.set(0);
    this.discoverYearMin.set(null);
    this.discoverYearMax.set(null);
    this.discoverResults.set([]);
    this.discoverActive.set(false);
  }
  /** A counter, not a boolean, so back-to-back refocus requests both fire the search page's effect. */
  readonly focusRequestId = signal(0);

  requestFocus(): void {
    this.focusRequestId.update((n) => n + 1);
  }

  /** A TMDB genre id (language-proof) to preload into the discover panel; the counter refires the effect on a reused route. */
  readonly genreFilterRequest = signal<{ genreId: number; n: number } | null>(
    null,
  );
  private genreFilterCounter = 0;

  requestGenreFilter(genreId: number): void {
    this.genreFilterRequest.set({ genreId, n: ++this.genreFilterCounter });
  }

  /** Video hits of the providers, best rated first, the panel filters applied. */
  readonly externalResults = computed(() =>
    this.applyPanelFilters([...this.movieHits(), ...this.seriesHits()].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))),
  );

  /** Whether a hit of the provider zone is held by the library: the library zone shows those the local search did not return. */
  readonly localMediaIds = computed(() => new Set(this.localResults().map((m) => m.id)));

  /** Hits with no row in the library: the provider zone. */
  readonly videoToAdd = computed(() => this.externalResults().filter((r) => r.existingMediaId == null));
  /** Library titles the provider matched by other metadata (franchise, keywords) that the title search missed. */
  readonly videoHeld = computed(() => this.externalResults().filter((r) => r.existingMediaId != null && !this.localMediaIds().has(r.existingMediaId)));
  readonly booksToAdd = computed(() => this.applyPanelFilters(this.bookHits().filter((r) => r.existingMediaId == null)));
  readonly booksHeld = computed(() => this.bookHits().filter((r) => r.existingMediaId != null && !this.localMediaIds().has(r.existingMediaId)));
  readonly albumsToAdd = computed(() => this.albumHits().filter((r) => r.existingMediaId == null));
  readonly albumsHeld = computed(() => this.albumHits().filter((r) => r.existingMediaId != null && !this.localMediaIds().has(r.existingMediaId)));
  readonly artistsToAdd = computed(() => {
    const local = new Set(this.localArtists().map((a) => a.id));
    return this.artistHits().filter((a) => a.personId == null || !local.has(a.personId));
  });
  /** Tracks the library does not hold: a recording the library has plays from the local list. */
  readonly recordingsToAdd = computed(() => this.recordingHits().filter((r) => r.trackId == null));

  /** Sorts only on a rating/recency pick (default keeps provider relevance); genre matches by TMDB id with a name fallback. */
  applyPanelFilters<T extends SearchHit>(rows: T[]): T[] {
    const ids = [...this.discoverSelectedGenres()];
    const names = this.selectedGenreNames();
    const voteMin = this.discoverVoteMin();
    const yearMin = this.discoverYearMin();
    const yearMax = this.discoverYearMax();

    const filtered = rows.filter((row) => {
      if (ids.length) {
        const byId = !!row.genreIds && ids.every((id) => row.genreIds!.includes(id));
        const byName = names.length > 0 && names.every((n) => (row.genres ?? []).includes(n));
        if (!byId && !byName) return false;
      }
      if ((row.rating ?? 0) < voteMin) return false;
      if (yearMin != null && (row.year == null || row.year < yearMin)) return false;
      if (yearMax != null && (row.year == null || row.year > yearMax)) return false;
      return true;
    });

    const sort = this.discoverSort();
    if (sort === 'primary_release_date.desc') {
      return [...filtered].sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    }
    if (sort === 'vote_average.desc') {
      return [...filtered].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    }
    return filtered;
  }

  clear() {
    this.query.set('');
    this.clearResults();
  }

  /** Empties every zone and its pending marks. */
  clearResults() {
    for (const l of [this.localResults, this.localTracks, this.localArtists, this.localAuthors, this.localSeries, this.peopleResults]) (l as WritableSignal<unknown[]>).set([]);
    for (const l of [this.movieHits, this.seriesHits, this.bookHits, this.albumHits, this.artistHits, this.recordingHits]) (l as WritableSignal<unknown[]>).set([]);
    this.pending.set(new Set());
    this.failed.set(new Set());
  }
}
