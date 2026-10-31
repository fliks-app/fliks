import { Injectable, signal, computed, effect } from '@angular/core';
import { Media } from './api/media.service';
import { MetadataSearchResult, TmdbGenre } from './api/metadata.service';
import { RecommendationItem } from './api/streaming-api.service';
import { SocialUser } from './api/social-api.service';
import { DEFAULT_SORT, filtersEngaged } from '../../shared/components/search-filters/search-filters';
import type { MediaType } from '../enums/media-type.enum';

const EXTERNAL_KEY = 'fliks-search-external';

@Injectable({ providedIn: 'root' })
export class SearchStateService {
  readonly query = signal('');
  /** Top-level surface: media (videos) vs members (people). */
  readonly tab = signal<'videos' | 'people'>('videos');
  /** Media type filter within the videos tab — drives search + discover
   *  (genre list, trending/popular). */
  readonly contentType = signal<'all' | MediaType>('all');
  readonly externalEnabled = signal(localStorage.getItem(EXTERNAL_KEY) !== 'false');

  private readonly persistExternal = effect(() => {
    localStorage.setItem(EXTERNAL_KEY, String(this.externalEnabled()));
  });
  readonly localResults = signal<Media[]>([]);
  readonly localLoading = signal(false);
  readonly externalResults = signal<MetadataSearchResult[]>([]);
  readonly externalLoading = signal(false);
  readonly peopleResults = signal<SocialUser[]>([]);
  readonly peopleLoading = signal(false);
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

  /** Only titles not already in the library (owned ones go to {@link ownedExternalResults}); narrowed by the panel filters while a query is active. */
  readonly filteredExternalResults = computed(() => {
    const localTmdbIds = new Set(this.localResults().map(m => m.tmdbId));
    const rows = this.externalResults().filter(
      (r) => r.existingMediaId == null && !localTmdbIds.has(r.tmdbId),
    );
    return this.applyPanelFilters(rows);
  });

  /** Library titles the provider matched by other metadata (franchise, keywords) that the title search missed, deduped against local. */
  readonly ownedExternalResults = computed(() => {
    const localTmdbIds = new Set(this.localResults().map(m => m.tmdbId));
    const rows = this.externalResults().filter(
      (r) => r.existingMediaId != null && !localTmdbIds.has(r.tmdbId),
    );
    return this.applyPanelFilters(rows);
  });

  /** Sorts only on a rating/recency pick (default keeps provider relevance); genre matches by TMDB id with a name fallback. */
  private applyPanelFilters(
    rows: MetadataSearchResult[],
  ): MetadataSearchResult[] {
    const ids = [...this.discoverSelectedGenres()];
    const names = this.selectedGenreNames();
    const voteMin = this.discoverVoteMin();
    const yearMin = this.discoverYearMin();
    const yearMax = this.discoverYearMax();

    const filtered = rows.filter((row) => {
      if (ids.length) {
        const byId = !!row.genreIds && ids.every((id) => row.genreIds!.includes(id));
        const byName = names.length > 0 && names.every((n) => row.genres.includes(n));
        if (!byId && !byName) return false;
      }
      if (row.rating < voteMin) return false;
      if (yearMin != null && (row.year == null || row.year < yearMin)) return false;
      if (yearMax != null && (row.year == null || row.year > yearMax)) return false;
      return true;
    });

    const sort = this.discoverSort();
    if (sort === 'primary_release_date.desc') {
      return [...filtered].sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    }
    if (sort === 'vote_average.desc') {
      return [...filtered].sort((a, b) => b.rating - a.rating);
    }
    return filtered;
  }

  clear() {
    this.query.set('');
    this.localResults.set([]);
    this.externalResults.set([]);
    this.peopleResults.set([]);
    this.localLoading.set(false);
    this.externalLoading.set(false);
    this.peopleLoading.set(false);
  }
}
