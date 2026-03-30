import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Media } from './media.service';

export interface MetadataSearchResult {
  tmdbId: number;
  title: string;
  originalTitle: string;
  overview: string;
  year: number | null;
  posterUrl: string | null;
  rating: number;
  genres: string[];
  mediaType: 'movie' | 'series';
  existingMediaId: number | null;
  existingMediaType: 'movie' | 'series' | null;
}

export interface MetadataDetails extends MetadataSearchResult {
  imdbId: string | null;
  fanartUrl: string | null;
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

@Injectable({ providedIn: 'root' })
export class MetadataService {
  private readonly http = inject(HttpClient);

  searchMovie(q: string, year?: number) {
    let params = new HttpParams().set('q', q);
    if (year != null) params = params.set('year', String(year));
    return firstValueFrom(
      this.http.get<MetadataSearchResult[]>('/api/metadata/search/movie', {
        params,
      }),
    );
  }

  searchTv(q: string, year?: number) {
    let params = new HttpParams().set('q', q);
    if (year != null) params = params.set('year', String(year));
    return firstValueFrom(
      this.http.get<MetadataSearchResult[]>('/api/metadata/search/tv', {
        params,
      }),
    );
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

  importFromTmdb(
    type: 'movie' | 'series',
    tmdbId: number,
    qualityProfileId?: number,
    rootFolderId?: number,
  ) {
    const body: { type: string; tmdbId: number; qualityProfileId?: number; rootFolderId?: number } = {
      type,
      tmdbId,
    };
    if (qualityProfileId != null) body.qualityProfileId = qualityProfileId;
    if (rootFolderId != null) body.rootFolderId = rootFolderId;
    return firstValueFrom(this.http.post<Media>('/api/media/import/tmdb', body));
  }
}
