import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { SKIP_ERROR_TOAST } from '../../interceptors/error.interceptor';
import { firstValueFrom } from 'rxjs';
import { MediaType } from '../../enums/media-type.enum';
import { Media } from './media.service';
import { KIND_REGISTRY, assertNever } from '../../media-kinds';

/** What every search answers (`/api/metadata/search/{kind}`), plus the extras of the hit's kind. */
export interface SearchHit {
  provider: string;
  /** The id in `provider`'s namespace, normalised by the server. */
  externalId: string;
  mediaType: MediaType;
  title: string;
  year: number | null;
  posterUrl: string | null;
  existingMediaId: number | null;
  /** Video hits only. */
  existingMediaType?: MediaType | null;
  /** Absent on a result of a provider that is not TMDB. */
  tmdbId?: number;
  tvdbId?: number | null;
  imdbId?: string | null;
  originalTitle?: string;
  overview?: string | null;
  fanartUrl?: string | null;
  rating?: number;
  genres?: string[];
  genreIds?: number[];
  subtitle?: string | null;
  authors?: string[];
  series?: { name: string; position: string | null } | null;
  editionCount?: number | null;
  publisher?: string | null;
  volume?: number | null;
  issueCount?: number | null;
  sourceUrl?: string | null;
}

/** A video title as the lists and details answer it. */
export interface MetadataSearchResult extends SearchHit {
  originalTitle: string;
  overview: string;
  rating: number;
  genres: string[];
  existingMediaType: MediaType | null;
}

export interface SearchOptions {
  year?: number;
  provider?: string;
  /** The provider that media is refreshed from is searched first; an explicit `provider` still comes before. */
  mediaId?: number;
  page?: number;
  /** Books only. */
  title?: string;
  author?: string;
  isbn?: string;
  language?: string;
}

/** TVDB reports `tmdbId: 0` for works TheMovieDB doesn't know, so every such row would share that key. */
export function searchResultKey(r: SearchHit): string {
  return `${r.provider}:${r.externalId ?? ''}:${r.tmdbId || 0}:${r.tvdbId || 0}`;
}

export interface ServingProvider {
  provider: string;
  label: string;
}

export interface ProvidersInfo {
  tmdb: boolean;
  serving: Record<MediaType, ServingProvider[]>;
}

/** `list` plus the stored choice when it is not served any more, so a select still shows it. */
export function withStoredProvider(list: ServingProvider[], stored: string | null): ServingProvider[] {
  return !stored || list.some((p) => p.provider === stored)
    ? list
    : [...list, { provider: stored, label: stored }];
}

/** The order a refresh reads `list` in: `preferred` first when it serves the kind. */
export function readOrder(list: ServingProvider[], preferred: string | null): ServingProvider[] {
  return [...list.filter((p) => p.provider === preferred), ...list.filter((p) => p.provider !== preferred)];
}

/** The ids worth sending to the API — the 0 above is not an id. */
export function searchResultIds(r: SearchHit): {
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
} {
  return {
    ...(r.tmdbId && r.tmdbId > 0 ? { tmdbId: r.tmdbId } : {}),
    ...(r.tvdbId ? { tvdbId: r.tvdbId } : {}),
    ...(r.imdbId ? { imdbId: r.imdbId } : {}),
  };
}

/** A cast/crew credit from the provider. */
export interface MetadataCredit {
  externalId: number;
  name: string;
  character?: string;
  job?: string;
  department?: string;
  avatarUrl: string | null;
  order?: number;
}

/** A provider video (trailer/teaser/clip), e.g. a YouTube key. */
export interface MetadataVideo {
  key: string;
  site: string;
  type: string;
  name: string;
}

export interface MetadataDetails extends MetadataSearchResult {
  imdbId: string | null;
  tvdbId: number | null;
  fanartUrl: string | null;
  additionalFanartUrls: string[];
  /** Transparent PNG "clearlogo" title treatment when the provider has one. */
  logoUrl: string | null;
  runtime: number | null;
  seasonCount: number | null;
  episodeCount: number | null;
  releaseDate: string | null;
  inCinemas: string | null;
  digitalRelease: string | null;
  physicalRelease: string | null;
  status: string;
  budget: number | null;
  revenue: number | null;
  originalLanguage: string | null;
  productionCountries: string[];
  productionCompanies: string[];
  voteCount: number | null;
  popularity: number | null;
  tagline: string | null;
  cast: MetadataCredit[];
  crew: MetadataCredit[];
  videos: MetadataVideo[];
  keywords: string[];
  tmdbCollectionId: number | null;
  tmdbCollectionName: string | null;
}

export interface MetadataEpisode {
  episodeNumber: number;
  title: string;
  overview: string | null;
  airDate: string | null;
  runtime: number | null;
  stillUrl: string | null;
}

/** A season without its episodes: what a season picker renders. */
export interface SeasonStub {
  seasonNumber: number;
  episodeCount: number;
}

export interface MetadataSeason {
  seasonNumber: number;
  episodeCount: number;
  overview: string | null;
  airDate: string | null;
  posterUrl: string | null;
  episodes: MetadataEpisode[];
}

/** A TMDB genre (id + localized name). */
export interface TmdbGenre {
  id: number;
  name: string;
}

/** Client-side discover filter values (V1 subset). */
export interface DiscoverFilters {
  genreIds?: number[];
  sort?: string;
  voteMin?: number;
  yearMin?: number | null;
  yearMax?: number | null;
}

@Injectable({ providedIn: 'root' })
export class MetadataService {
  private readonly http = inject(HttpClient);

  /** One search for every kind; the server walks the providers serving it. */
  search(kind: MediaType, q: string, opts: SearchOptions = {}) {
    let params = new HttpParams();
    if (q) params = params.set('q', q);
    for (const [key, value] of Object.entries(opts)) {
      if (value != null && value !== '') params = params.set(key, String(value));
    }
    return firstValueFrom(
      this.http.get<SearchHit[]>(`/api/metadata/search/${KIND_REGISTRY[kind].providerSegment}`, { params }),
    );
  }

  getTrendingMovies(window: 'day' | 'week' = 'week') { return firstValueFrom(this.http.get<MetadataSearchResult[]>('/api/metadata/trending/movie', { params: { window } })); }
  getPopularMovies() { return firstValueFrom(this.http.get<MetadataSearchResult[]>('/api/metadata/popular/movie')); }
  getUpcomingMovies() { return firstValueFrom(this.http.get<MetadataSearchResult[]>('/api/metadata/upcoming/movie')); }
  getTrendingTv(window: 'day' | 'week' = 'week') { return firstValueFrom(this.http.get<MetadataSearchResult[]>('/api/metadata/trending/tv', { params: { window } })); }
  getPopularTv() { return firstValueFrom(this.http.get<MetadataSearchResult[]>('/api/metadata/popular/tv')); }
  getUpcomingTv() { return firstValueFrom(this.http.get<MetadataSearchResult[]>('/api/metadata/upcoming/tv')); }

  getMovieGenres() { return firstValueFrom(this.http.get<TmdbGenre[]>('/api/metadata/genres/movie')); }
  getTvGenres() { return firstValueFrom(this.http.get<TmdbGenre[]>('/api/metadata/genres/tv')); }

  private discoverParams(opts: DiscoverFilters): HttpParams {
    let params = new HttpParams();
    if (opts.genreIds?.length) params = params.set('genres', opts.genreIds.join(','));
    if (opts.sort) params = params.set('sort', opts.sort);
    if (opts.voteMin) params = params.set('voteGte', String(opts.voteMin));
    if (opts.yearMin) params = params.set('yearGte', String(opts.yearMin));
    if (opts.yearMax) params = params.set('yearLte', String(opts.yearMax));
    return params;
  }

  discoverMovies(opts: DiscoverFilters) {
    return firstValueFrom(this.http.get<MetadataSearchResult[]>('/api/metadata/discover/movie', { params: this.discoverParams(opts) }));
  }

  discoverTv(opts: DiscoverFilters) {
    return firstValueFrom(this.http.get<MetadataSearchResult[]>('/api/metadata/discover/tv', { params: this.discoverParams(opts) }));
  }

  discoverByKind(type: MediaType, opts: DiscoverFilters) {
    switch (type) {
      case 'movie': return this.discoverMovies(opts);
      case 'series': return this.discoverTv(opts);
      case 'book': throw new Error('Books go through BooksApiService');
      case 'comic': throw new Error('Comics have no external metadata provider yet');
      default: return assertNever(type);
    }
  }

  genresByKind(type: MediaType) {
    switch (type) {
      case 'movie': return this.getMovieGenres();
      case 'series': return this.getTvGenres();
      case 'book': throw new Error('Books go through BooksApiService');
      case 'comic': throw new Error('Comics have no external metadata provider yet');
      default: return assertNever(type);
    }
  }

  trendingByKind(type: MediaType, window: 'day' | 'week' = 'week') {
    switch (type) {
      case 'movie': return this.getTrendingMovies(window);
      case 'series': return this.getTrendingTv(window);
      case 'book': throw new Error('Books go through BooksApiService');
      case 'comic': throw new Error('Comics have no external metadata provider yet');
      default: return assertNever(type);
    }
  }

  popularByKind(type: MediaType) {
    switch (type) {
      case 'movie': return this.getPopularMovies();
      case 'series': return this.getPopularTv();
      case 'book': throw new Error('Books go through BooksApiService');
      case 'comic': throw new Error('Comics have no external metadata provider yet');
      default: return assertNever(type);
    }
  }

  private providers() {
    return firstValueFrom(this.http.get<ProvidersInfo>('/api/metadata/providers'));
  }

  /** Whether TMDB answers: a request is keyed by `tmdbId` only then. */
  async isTmdbAvailable(): Promise<boolean> {
    return (await this.providers()).tmdb;
  }

  /** The available providers of every kind, each in the admin's order. */
  async providersByKind(): Promise<Record<MediaType, ServingProvider[]>> {
    return (await this.providers()).serving;
  }

  /** The available providers serving a kind, in the admin's order. */
  async providersServing(kind: MediaType) {
    return (await this.providers()).serving[kind];
  }

  /** Season numbers + episode counts only: one provider call, unlike
   *  {@link getSeasons} which fetches every episode of every season. */
  getSeasonStubs(provider: string, externalId: string) {
    return firstValueFrom(
      this.http.get<SeasonStub[]>(`/api/metadata/${provider}/tv/${encodeURIComponent(externalId)}/season-stubs`),
    );
  }

  getSeasons(provider: string, externalId: string) {
    return firstValueFrom(
      this.http.get<MetadataSeason[]>(
        `/api/metadata/${provider}/tv/${encodeURIComponent(externalId)}/seasons`,
      ),
    );
  }

  /** Provider-aware detail fetch */
  getDetails(provider: string, mediaType: MediaType, externalId: string, opts: { silent?: boolean } = {}) {
    const segment = KIND_REGISTRY[mediaType].providerSegment;
    const context = new HttpContext().set(SKIP_ERROR_TOAST, !!opts.silent);
    return firstValueFrom(
      this.http.get<MetadataDetails>(`/api/metadata/${provider}/${segment}/${encodeURIComponent(externalId)}`, { context }),
    );
  }

  importFromTmdb(
    type: MediaType,
    tmdbId: number,
    qualityProfileId?: number,
    languageProfileId?: number,
    libraryId?: number,
  ) {
    const body: { type: string; tmdbId: number; qualityProfileId?: number; languageProfileId?: number; libraryId?: number } = {
      type,
      tmdbId,
    };
    if (qualityProfileId != null) body.qualityProfileId = qualityProfileId;
    if (languageProfileId != null) body.languageProfileId = languageProfileId;
    if (libraryId != null) body.libraryId = libraryId;
    return firstValueFrom(this.http.post<Media>('/api/media/import/tmdb', body));
  }

  /** Provider-aware import */
  importMedia(opts: {
    type: MediaType;
    externalId: string;
    provider: string;
    qualityProfileId?: number;
    languageProfileId?: number;
    libraryId?: number;
    /** One of the library's folders; omitted means its default one. */
    folderId?: number;
    /** Series only: seasons to monitor. Omitted monitors every season but the
     *  specials. */
    monitoredSeasons?: number[];
  }) {
    return firstValueFrom(this.http.post<Media>('/api/media/import', opts));
  }
}
