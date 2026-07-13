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
  mediaType: MediaType;
  existingMediaId: number | null;
  existingMediaType: MediaType | null;
}

export interface MetadataDetails extends MetadataSearchResult {
  imdbId: string | null;
  tvdbId: number | null;
  fanartUrl: string | null;
  /** Transparent PNG "clearlogo" title treatment when the provider has one. */
  logoUrl: string | null;
  runtime: number | null;
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
}

export interface SeasonStub {
  seasonNumber: number;
  episodeCount: number;
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

  searchMovie(q: string, year?: number, provider?: string) {
    let params = new HttpParams().set('q', q);
    if (year != null) params = params.set('year', String(year));
    if (provider) params = params.set('provider', provider);
    return firstValueFrom(
      this.http.get<MetadataSearchResult[]>('/api/metadata/search/movie', {
        params,
      }),
    );
  }

  searchTv(q: string, year?: number, provider?: string) {
    let params = new HttpParams().set('q', q);
    if (year != null) params = params.set('year', String(year));
    if (provider) params = params.set('provider', provider);
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
      this.http.get<SeasonStub[]>(`/api/metadata/tv/${tmdbId}/seasons`),
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
