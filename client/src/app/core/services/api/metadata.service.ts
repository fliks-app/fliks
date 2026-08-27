import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { MediaType } from '../../enums/media-type.enum';
import { Media } from './media.service';

export interface MetadataSearchResult {
  tmdbId: number;
  tvdbId?: number | null;
  imdbId?: string | null;
  provider: string;
  title: string;
  originalTitle: string;
  overview: string;
  year: number | null;
  posterUrl: string | null;
  rating: number;
  genres: string[];
  genreIds?: number[];
  mediaType: MediaType;
  existingMediaId: number | null;
  existingMediaType: MediaType | null;
}

/**
 * A result's identity for the UI: TVDB reports `tmdbId: 0` for a work
 * TheMovieDB does not know, so every one of its rows would share that key.
 */
export function searchResultKey(r: MetadataSearchResult): string {
  return `${r.provider}:${r.tmdbId || 0}:${r.tvdbId || 0}`;
}

/** The ids worth sending to the API — the 0 above is not an id. */
export function searchResultIds(r: MetadataSearchResult): {
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
} {
  return {
    ...(r.tmdbId > 0 ? { tmdbId: r.tmdbId } : {}),
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

  /** `mediaId` lets the server search the provider that media is refreshed
   *  from; an explicit `provider` still wins. */
  searchMovie(q: string, year?: number, provider?: string, mediaId?: number) {
    let params = new HttpParams().set('q', q);
    if (year != null) params = params.set('year', String(year));
    if (provider) params = params.set('provider', provider);
    if (mediaId != null) params = params.set('mediaId', String(mediaId));
    return firstValueFrom(
      this.http.get<MetadataSearchResult[]>('/api/metadata/search/movie', {
        params,
      }),
    );
  }

  /** `mediaId` lets the server search the provider that media is refreshed
   *  from; an explicit `provider` still wins. */
  searchTv(q: string, year?: number, provider?: string, mediaId?: number) {
    let params = new HttpParams().set('q', q);
    if (year != null) params = params.set('year', String(year));
    if (provider) params = params.set('provider', provider);
    if (mediaId != null) params = params.set('mediaId', String(mediaId));
    return firstValueFrom(
      this.http.get<MetadataSearchResult[]>('/api/metadata/search/tv', {
        params,
      }),
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

  getMovieDetails(tmdbId: number) {
    return firstValueFrom(
      this.http.get<MetadataDetails>(`/api/metadata/movie/${tmdbId}`),
    );
  }

  getTvDetails(tmdbId: number) {
    return firstValueFrom(
      this.http.get<MetadataDetails>(`/api/metadata/tv/${tmdbId}`),
    );
  }

  getTvSeasons(tmdbId: number) {
    return firstValueFrom(
      this.http.get<MetadataSeason[]>(`/api/metadata/tv/${tmdbId}/seasons`),
    );
  }

  getSeasons(provider: string, externalId: string) {
    return firstValueFrom(
      this.http.get<MetadataSeason[]>(
        `/api/metadata/${provider}/tv/${externalId}/seasons`,
      ),
    );
  }

  /** Provider-aware detail fetch */
  getDetails(provider: string, mediaType: 'movie' | 'series', externalId: string) {
    const segment = mediaType === 'series' ? 'tv' : 'movie';
    return firstValueFrom(
      this.http.get<MetadataDetails>(`/api/metadata/${provider}/${segment}/${externalId}`),
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
  }) {
    return firstValueFrom(this.http.post<Media>('/api/media/import', opts));
  }
}
