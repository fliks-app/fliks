import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import {
  IMetadataProvider,
  MetadataSearchResult,
  MetadataDetails,
  SeasonDetails,
} from '../interfaces/metadata-provider.interface';

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

@Injectable()
export class TmdbProvider implements IMetadataProvider {
  readonly name = 'tmdb';
  private readonly client: AxiosInstance;
  private readonly logger = new Logger(TmdbProvider.name);

  constructor(private readonly config: ConfigService) {
    this.client = axios.create({
      baseURL: 'https://api.themoviedb.org/3',
      params: { api_key: this.config.get('TMDB_API_KEY', '') },
      timeout: 10000,
    });
  }

  async searchMovie(query: string, year?: number): Promise<MetadataSearchResult[]> {
    const params: Record<string, unknown> = { query, language: 'fr-FR' };
    if (year) params.year = year;

    const { data } = await this.client.get('/search/movie', { params });
    return data.results.map((r: any) => this.mapMovieResult(r));
  }

  async searchTvShow(query: string, year?: number): Promise<MetadataSearchResult[]> {
    const params: Record<string, unknown> = { query, language: 'fr-FR' };
    if (year) params.first_air_date_year = year;

    const { data } = await this.client.get('/search/tv', { params });
    return data.results.map((r: any) => this.mapTvResult(r));
  }

  async getMovieDetails(tmdbId: number): Promise<MetadataDetails> {
    const { data } = await this.client.get(`/movie/${tmdbId}`, {
      params: {
        language: 'fr-FR',
        append_to_response: 'external_ids,images,release_dates',
      },
    });

    const dates = this.extractReleaseDates(data.release_dates?.results ?? []);

    return {
      tmdbId: data.id,
      title: data.title,
      originalTitle: data.original_title,
      overview: data.overview,
      year: data.release_date ? parseInt(data.release_date) : null,
      posterUrl: data.poster_path ? `${TMDB_IMAGE_BASE}/w500${data.poster_path}` : null,
      fanartUrl: data.backdrop_path ? `${TMDB_IMAGE_BASE}/original${data.backdrop_path}` : null,
      rating: data.vote_average,
      genres: data.genres?.map((g: any) => g.name) ?? [],
      mediaType: 'movie',
      imdbId: data.external_ids?.imdb_id ?? data.imdb_id ?? null,
      runtime: data.runtime,
      releaseDate: data.release_date,
      inCinemas: dates.inCinemas,
      digitalRelease: dates.digitalRelease,
      physicalRelease: dates.physicalRelease,
      status: data.status?.toLowerCase() ?? 'unknown',
      budget: data.budget || null,
      revenue: data.revenue || null,
      originalLanguage: data.original_language ?? null,
      productionCountries: (data.production_countries ?? []).map((c: any) => c.name),
      productionCompanies: (data.production_companies ?? []).map((c: any) => c.name),
      voteCount: data.vote_count ?? null,
      popularity: data.popularity ?? null,
    };
  }

  async getTvShowDetails(tmdbId: number): Promise<MetadataDetails> {
    const { data } = await this.client.get(`/tv/${tmdbId}`, {
      params: { language: 'fr-FR', append_to_response: 'external_ids,images' },
    });
    return {
      tmdbId: data.id,
      title: data.name,
      originalTitle: data.original_name,
      overview: data.overview,
      year: data.first_air_date ? parseInt(data.first_air_date) : null,
      posterUrl: data.poster_path ? `${TMDB_IMAGE_BASE}/w500${data.poster_path}` : null,
      fanartUrl: data.backdrop_path ? `${TMDB_IMAGE_BASE}/original${data.backdrop_path}` : null,
      rating: data.vote_average,
      genres: data.genres?.map((g: any) => g.name) ?? [],
      mediaType: 'series',
      imdbId: data.external_ids?.imdb_id ?? null,
      runtime: data.episode_run_time?.[0] ?? null,
      releaseDate: data.first_air_date,
      inCinemas: null,
      digitalRelease: null,
      physicalRelease: null,
      status: this.mapTvStatus(data.status),
      budget: null,
      revenue: null,
      originalLanguage: data.original_language ?? null,
      productionCountries: (data.origin_country ?? []) as string[],
      productionCompanies: [
        ...((data.networks ?? []).map((n: any) => n.name)),
        ...((data.production_companies ?? []).map((c: any) => c.name)),
      ],
      voteCount: data.vote_count ?? null,
      popularity: data.popularity ?? null,
    };
  }

  /**
   * Saisons + nombre d’épisodes (un seul appel API), pour import bibliothèque sans N requêtes /season.
   */
  async getTvSeasonStubs(
    tmdbId: number,
  ): Promise<{ seasonNumber: number; episodeCount: number }[]> {
    const { data: show } = await this.client.get(`/tv/${tmdbId}`, {
      params: { language: 'fr-FR' },
    });
    return (show.seasons ?? [])
      .filter((s: { season_number: number }) => s.season_number > 0)
      .map((s: { season_number: number; episode_count?: number }) => ({
        seasonNumber: s.season_number,
        episodeCount: s.episode_count ?? 0,
      }));
  }

  async getTvShowSeasons(tmdbId: number): Promise<SeasonDetails[]> {
    const { data: show } = await this.client.get(`/tv/${tmdbId}`, {
      params: { language: 'fr-FR' },
    });

    const seasons: SeasonDetails[] = [];
    for (const s of show.seasons ?? []) {
      if (s.season_number === 0) continue;
      try {
        const { data: season } = await this.client.get(
          `/tv/${tmdbId}/season/${s.season_number}`,
          { params: { language: 'fr-FR' } },
        );
        seasons.push({
          seasonNumber: season.season_number,
          episodeCount: season.episodes?.length ?? 0,
          overview: season.overview || null,
          airDate: season.air_date || null,
          episodes: (season.episodes ?? []).map((e: any) => ({
            episodeNumber: e.episode_number,
            title: e.name,
            overview: e.overview || null,
            airDate: e.air_date || null,
          })),
        });
      } catch (err) {
        this.logger.warn(`Failed to fetch season ${s.season_number} for TV ${tmdbId}`);
      }
    }
    return seasons;
  }

  async getTrendingMovies(): Promise<MetadataSearchResult[]> {
    const { data } = await this.client.get('/trending/movie/week', { params: { language: 'fr-FR' } });
    return data.results.map((r: any) => this.mapMovieResult(r));
  }

  async getPopularMovies(): Promise<MetadataSearchResult[]> {
    const { data } = await this.client.get('/movie/popular', { params: { language: 'fr-FR' } });
    return data.results.map((r: any) => this.mapMovieResult(r));
  }

  async getUpcomingMovies(): Promise<MetadataSearchResult[]> {
    const { data } = await this.client.get('/movie/upcoming', { params: { language: 'fr-FR', region: 'FR' } });
    return data.results.map((r: any) => this.mapMovieResult(r));
  }

  async getTrendingTvShows(): Promise<MetadataSearchResult[]> {
    const { data } = await this.client.get('/trending/tv/week', { params: { language: 'fr-FR' } });
    return data.results.map((r: any) => this.mapTvResult(r));
  }

  async getPopularTvShows(): Promise<MetadataSearchResult[]> {
    const { data } = await this.client.get('/tv/popular', { params: { language: 'fr-FR' } });
    return data.results.map((r: any) => this.mapTvResult(r));
  }

  async getUpcomingTvShows(): Promise<MetadataSearchResult[]> {
    const { data } = await this.client.get('/tv/on_the_air', { params: { language: 'fr-FR' } });
    return data.results.map((r: any) => this.mapTvResult(r));
  }

  private mapMovieResult(r: any): MetadataSearchResult {
    return {
      tmdbId: r.id,
      title: r.title,
      originalTitle: r.original_title,
      overview: r.overview,
      year: r.release_date ? parseInt(r.release_date) : null,
      posterUrl: r.poster_path ? `${TMDB_IMAGE_BASE}/w500${r.poster_path}` : null,
      rating: r.vote_average,
      genres: [],
      mediaType: 'movie',
    };
  }

  private mapTvResult(r: any): MetadataSearchResult {
    return {
      tmdbId: r.id,
      title: r.name,
      originalTitle: r.original_name,
      overview: r.overview,
      year: r.first_air_date ? parseInt(r.first_air_date) : null,
      posterUrl: r.poster_path ? `${TMDB_IMAGE_BASE}/w500${r.poster_path}` : null,
      rating: r.vote_average,
      genres: [],
      mediaType: 'series',
    };
  }

  /**
   * Extract cinema, digital, and physical release dates from TMDB release_dates.
   * TMDB release types: 1=Premiere, 2=Theatrical Limited, 3=Theatrical, 4=Digital, 5=Physical, 6=TV.
   * Priority: FR → US → any country. Earliest date per type wins.
   */
  private extractReleaseDates(
    results: { iso_3166_1: string; release_dates: { type: number; release_date: string }[] }[],
  ): { inCinemas: string | null; digitalRelease: string | null; physicalRelease: string | null } {
    const dates: Record<number, string> = {};

    // Priority order for countries
    const priority = ['FR', 'US'];
    const sorted = [...results].sort((a, b) => {
      const ai = priority.indexOf(a.iso_3166_1);
      const bi = priority.indexOf(b.iso_3166_1);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    for (const country of sorted) {
      for (const rd of country.release_dates) {
        if (!rd.release_date) continue;
        const d = rd.release_date.slice(0, 10);
        if (!dates[rd.type] || d < dates[rd.type]) {
          dates[rd.type] = d;
        }
      }
    }

    return {
      inCinemas: dates[3] ?? dates[2] ?? dates[1] ?? null,
      digitalRelease: dates[4] ?? null,
      physicalRelease: dates[5] ?? null,
    };
  }

  private mapTvStatus(status: string): string {
    const map: Record<string, string> = {
      'Returning Series': 'continuing',
      Ended: 'ended',
      Canceled: 'ended',
      'In Production': 'announced',
      Planned: 'tba',
    };
    return map[status] ?? 'unknown';
  }
}
