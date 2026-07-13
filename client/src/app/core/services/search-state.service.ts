import { Injectable, signal, computed, effect } from '@angular/core';
import { Media } from './api/media.service';
import { MetadataSearchResult, TmdbGenre } from './api/metadata.service';
import { RecommendationItem } from './api/streaming-api.service';
import { SocialUser } from './api/social-api.service';

const EXTERNAL_KEY = 'fliks-search-external';

@Injectable({ providedIn: 'root' })
export class SearchStateService {
  readonly query = signal('');
  readonly filter = signal<'all' | 'movie' | 'series' | 'people'>('all');
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
  readonly discoverSelectedGenres = signal<Set<number>>(new Set());
  readonly discoverSort = signal('popularity.desc');
  readonly discoverVoteMin = signal(0);
  readonly discoverYearMin = signal<number | null>(null);
  readonly discoverYearMax = signal<number | null>(null);
  /** Results of an applied discover query. */
  readonly discoverResults = signal<MetadataSearchResult[]>([]);
  readonly discoverLoading = signal(false);
  /** True once a discover query has been applied (rows → results grid). */
  readonly discoverActive = signal(false);

  /** Reset the discover panel filters + results. */
  resetDiscover(): void {
    this.discoverSelectedGenres.set(new Set());
    this.discoverSort.set('popularity.desc');
    this.discoverVoteMin.set(0);
    this.discoverYearMin.set(null);
    this.discoverYearMax.set(null);
    this.discoverResults.set([]);
    this.discoverActive.set(false);
  }
  /** Counter incremented whenever a caller (e.g. the bottom-dock
   *  search button) asks the search page to refocus its input.
   *  Search page watches this in an effect — using a counter (not a
   *  boolean) so back-to-back requests both fire. */
  readonly focusRequestId = signal(0);

  requestFocus(): void {
    this.focusRequestId.update((n) => n + 1);
  }

  /** External results for the "add to library" section: only titles NOT already
   *  in the library (owned ones move to {@link ownedExternalResults}). */
  readonly filteredExternalResults = computed(() => {
    const localTmdbIds = new Set(this.localResults().map(m => m.tmdbId));
    return this.externalResults().filter(
      (r) => r.existingMediaId == null && !localTmdbIds.has(r.tmdbId),
    );
  });

  /** Library titles the provider matched by other metadata (franchise, keywords,
   *  alternative titles…) that the local title search missed — e.g. a spin-off
   *  whose title doesn't contain the searched franchise name. Surfaced in the
   *  library section so owned matches show at the top. Deduped against local. */
  readonly ownedExternalResults = computed(() => {
    const localTmdbIds = new Set(this.localResults().map(m => m.tmdbId));
    return this.externalResults().filter(
      (r) => r.existingMediaId != null && !localTmdbIds.has(r.tmdbId),
    );
  });

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
