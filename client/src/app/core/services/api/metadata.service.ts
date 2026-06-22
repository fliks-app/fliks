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

  getTrendingMovies() { return firstValueFrom(this.http.get<MetadataSearchResult[]>('/api/metadata/trending/movie')); }
  getPopularMovies() { return firstValueFrom(this.http.get<MetadataSearchResult[]>('/api/metadata/popular/movie')); }
  getUpcomingMovies() { return firstValueFrom(this.http.get<MetadataSearchResult[]>('/api/metadata/upcoming/movie')); }
  getTrendingTv() { return firstValueFrom(this.http.get<MetadataSearchResult[]>('/api/metadata/trending/tv')); }
  getPopularTv() { return firstValueFrom(this.http.get<MetadataSearchResult[]>('/api/metadata/popular/tv')); }
  getUpcomingTv() { return firstValueFrom(this.http.get<MetadataSearchResult[]>('/api/metadata/upcoming/tv')); }

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
