import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import {
  IMetadataProvider,
  MetadataSearchResult,
  MetadataDetails,
  SeasonDetails,
  PersonDetails,
  PersonCombinedCredits,
} from '../interfaces/metadata-provider.interface';
import type {
  TmdbMovieDetailsResponse,
  TmdbMovieListItem,
  TmdbPaginated,
  TmdbTvDetailsResponse,
  TmdbTvEpisode,
  TmdbTvListItem,
  TmdbTvSeasonResponse,
  TmdbTvShowWithSeasons,
  TmdbNamed,
  TmdbPersonDetailsResponse,
  TmdbPersonCombinedCreditsResponse,
} from './tmdb-api.types';

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

@Injectable()
export class TmdbProvider implements IMetadataProvider {
  readonly name = 'tmdb';
  private readonly client: AxiosInstance;
  private readonly logger = new Logger(TmdbProvider.name);

  constructor(private readonly config: ConfigService) {
    this.client = axios.create({
      baseURL: 'https://api.themoviedb.org/3',
      params: { api_key: this.config.get<string>('TMDB_API_KEY', '') },
      timeout: 10000,
    });
  }

  async searchMovie(
    query: string,
    year?: number,
  ): Promise<MetadataSearchResult[]> {
    const params: Record<string, unknown> = { query, language: 'fr-FR' };
    if (year) params.year = year;

    const { data } = await this.client.get<TmdbPaginated<TmdbMovieListItem>>(
      '/search/movie',
      { params },
    );
    return data.results.map((r) => this.mapMovieResult(r));
  }

  async searchTvShow(
    query: string,
    year?: number,
  ): Promise<MetadataSearchResult[]> {
    const params: Record<string, unknown> = { query, language: 'fr-FR' };
    if (year) params.first_air_date_year = year;

    const { data } = await this.client.get<TmdbPaginated<TmdbTvListItem>>(
      '/search/tv',
      { params },
    );
    return data.results.map((r) => this.mapTvResult(r));
  }

  async getMovieDetails(tmdbId: number): Promise<MetadataDetails> {
    const { data } = await this.client.get<TmdbMovieDetailsResponse>(
      `/movie/${tmdbId}`,
      {
        params: {
          language: 'fr-FR',
          append_to_response: 'external_ids,images,release_dates,credits,videos,keywords',
        },
      },
    );

    const dates = this.extractReleaseDates(data.release_dates?.results ?? []);

    return {
      tmdbId: data.id,
      title: data.title,
      originalTitle: data.original_title,
      overview: data.overview,
      year: data.release_date ? parseInt(data.release_date) : null,
      posterUrl: data.poster_path
        ? `${TMDB_IMAGE_BASE}/w500${data.poster_path}`
        : null,
      fanartUrl: data.backdrop_path
        ? `${TMDB_IMAGE_BASE}/original${data.backdrop_path}`
        : null,
      rating: data.vote_average ?? 0,
      genres: data.genres?.map((g: TmdbNamed) => g.name) ?? [],
      mediaType: 'movie',
      imdbId: data.external_ids?.imdb_id ?? data.imdb_id ?? null,
      runtime: data.runtime ?? null,
      releaseDate: data.release_date ?? null,
      inCinemas: dates.inCinemas,
      digitalRelease: dates.digitalRelease,
      physicalRelease: dates.physicalRelease,
      status: data.status?.toLowerCase() ?? 'unknown',
      budget: data.budget || null,
      revenue: data.revenue || null,
      originalLanguage: data.original_language ?? null,
      productionCountries: (data.production_countries ?? []).map((c) => c.name),
      productionCompanies: (data.production_companies ?? []).map((c) => c.name),
      voteCount: data.vote_count ?? null,
      popularity: data.popularity ?? null,
      tagline: data.tagline || null,
      cast: (data.credits?.cast ?? []).map((c) => ({
        externalId: c.id,
        name: c.name,
        character: c.character,
        avatarUrl: c.profile_path
          ? `${TMDB_IMAGE_BASE}/w185${c.profile_path}`
          : null,
        order: c.order,
      })),
      crew: (data.credits?.crew ?? []).map((c) => ({
        externalId: c.id,
        name: c.name,
        job: c.job,
        department: c.department,
        avatarUrl: c.profile_path
          ? `${TMDB_IMAGE_BASE}/w185${c.profile_path}`
          : null,
      })),
      videos: (data.videos?.results ?? []).map((v) => ({
        key: v.key,
        site: v.site,
        type: v.type,
        name: v.name,
      })),
      keywords: (data.keywords?.keywords ?? []).map((k) => k.name),
    };
  }

  async getTvShowDetails(tmdbId: number): Promise<MetadataDetails> {
    const { data } = await this.client.get<TmdbTvDetailsResponse>(
      `/tv/${tmdbId}`,
      {
        params: {
          language: 'fr-FR',
          append_to_response: 'external_ids,images,credits,videos,keywords',
        },
      },
    );
    return {
      tmdbId: data.id,
      title: data.name,
      originalTitle: data.original_name,
      overview: data.overview,
      year: data.first_air_date ? parseInt(data.first_air_date) : null,
      posterUrl: data.poster_path
        ? `${TMDB_IMAGE_BASE}/w500${data.poster_path}`
        : null,
      fanartUrl: data.backdrop_path
        ? `${TMDB_IMAGE_BASE}/original${data.backdrop_path}`
        : null,
      rating: data.vote_average ?? 0,
      genres: data.genres?.map((g: TmdbNamed) => g.name) ?? [],
      mediaType: 'series',
      imdbId: data.external_ids?.imdb_id ?? null,
      runtime: data.episode_run_time?.[0] ?? null,
      releaseDate: data.first_air_date ?? null,
      inCinemas: null,
      digitalRelease: null,
      physicalRelease: null,
      status: this.mapTvStatus(data.status ?? ''),
      budget: null,
      revenue: null,
      originalLanguage: data.original_language ?? null,
      productionCountries: data.origin_country ?? [],
      productionCompanies: [
        ...(data.networks ?? []).map((n) => n.name),
        ...(data.production_companies ?? []).map((c) => c.name),
      ],
      voteCount: data.vote_count ?? null,
      popularity: data.popularity ?? null,
      tagline: data.tagline || null,
      cast: (data.credits?.cast ?? []).map((c) => ({
        externalId: c.id,
        name: c.name,
        character: c.character,
        avatarUrl: c.profile_path
          ? `${TMDB_IMAGE_BASE}/w185${c.profile_path}`
          : null,
        order: c.order,
      })),
      crew: (data.credits?.crew ?? []).map((c) => ({
        externalId: c.id,
        name: c.name,
        job: c.job,
        department: c.department,
        avatarUrl: c.profile_path
          ? `${TMDB_IMAGE_BASE}/w185${c.profile_path}`
          : null,
      })),
      videos: (data.videos?.results ?? []).map((v) => ({
        key: v.key,
        site: v.site,
        type: v.type,
        name: v.name,
      })),
      keywords: (data.keywords?.results ?? []).map((k) => k.name),
    };
  }

  /**
   * Saisons + nombre d’épisodes (un seul appel API), pour import bibliothèque sans N requêtes /season.
   */
  async getTvSeasonStubs(
    tmdbId: number,
  ): Promise<{ seasonNumber: number; episodeCount: number }[]> {
    const { data: show } = await this.client.get<TmdbTvShowWithSeasons>(
      `/tv/${tmdbId}`,
      {
        params: { language: 'fr-FR' },
      },
    );
    return (show.seasons ?? [])
      .filter((s) => s.season_number > 0)
      .map((s) => ({
        seasonNumber: s.season_number,
        episodeCount: s.episode_count ?? 0,
      }));
  }

  async getTvShowSeasons(tmdbId: number): Promise<SeasonDetails[]> {
    const { data: show } = await this.client.get<TmdbTvShowWithSeasons>(
      `/tv/${tmdbId}`,
      {
        params: { language: 'fr-FR' },
      },
    );

    const seasons: SeasonDetails[] = [];
    for (const s of show.seasons ?? []) {
      if (s.season_number === 0) continue;
      try {
        const { data: season } = await this.client.get<TmdbTvSeasonResponse>(
          `/tv/${tmdbId}/season/${s.season_number}`,
          { params: { language: 'fr-FR' } },
        );
        seasons.push({
          seasonNumber: season.season_number,
          episodeCount: season.episodes?.length ?? 0,
          overview: season.overview || null,
          airDate: season.air_date || null,
          episodes: (season.episodes ?? []).map((e: TmdbTvEpisode) => ({
            episodeNumber: e.episode_number,
            title: e.name,
            overview: e.overview || null,
            airDate: e.air_date || null,
            runtime: e.runtime ?? null,
            stillUrl: e.still_path
              ? `${TMDB_IMAGE_BASE}/w780${e.still_path}`
              : null,
          })),
        });
      } catch (err) {
        this.logger.warn(
          `Failed to fetch season ${s.season_number} for TV ${tmdbId}`,
        );
      }
    }
    return seasons;
  }

  async getTrendingMovies(): Promise<MetadataSearchResult[]> {
    const { data } = await this.client.get<TmdbPaginated<TmdbMovieListItem>>(
      '/trending/movie/week',
      {
        params: { language: 'fr-FR' },
      },
    );
    return data.results.map((r) => this.mapMovieResult(r));
  }

  async getPopularMovies(): Promise<MetadataSearchResult[]> {
    const { data } = await this.client.get<TmdbPaginated<TmdbMovieListItem>>(
      '/movie/popular',
      {
        params: { language: 'fr-FR' },
      },
    );
    return data.results.map((r) => this.mapMovieResult(r));
  }

  async getUpcomingMovies(): Promise<MetadataSearchResult[]> {
    const { data } = await this.client.get<TmdbPaginated<TmdbMovieListItem>>(
      '/movie/upcoming',
      {
        params: { language: 'fr-FR', region: 'FR' },
      },
    );
    return data.results.map((r) => this.mapMovieResult(r));
  }

  async getTrendingTvShows(): Promise<MetadataSearchResult[]> {
    const { data } = await this.client.get<TmdbPaginated<TmdbTvListItem>>(
      '/trending/tv/week',
      {
        params: { language: 'fr-FR' },
      },
    );
    return data.results.map((r) => this.mapTvResult(r));
  }

  async getPopularTvShows(): Promise<MetadataSearchResult[]> {
    const { data } = await this.client.get<TmdbPaginated<TmdbTvListItem>>(
      '/tv/popular',
      {
        params: { language: 'fr-FR' },
      },
    );
    return data.results.map((r) => this.mapTvResult(r));
  }

  async getUpcomingTvShows(): Promise<MetadataSearchResult[]> {
    const { data } = await this.client.get<TmdbPaginated<TmdbTvListItem>>(
      '/tv/on_the_air',
      {
        params: { language: 'fr-FR' },
      },
    );
    return data.results.map((r) => this.mapTvResult(r));
  }

  async getPersonDetails(externalId: number): Promise<PersonDetails> {
    const { data } = await this.client.get<TmdbPersonDetailsResponse>(
      `/person/${externalId}`,
      { params: { language: 'fr-FR' } },
    );
    return {
      externalId: data.id,
      name: data.name,
      biography: data.biography,
      birthday: data.birthday ?? null,
      deathday: data.deathday ?? null,
      placeOfBirth: data.place_of_birth ?? null,
      avatarUrl: data.profile_path
        ? `${TMDB_IMAGE_BASE}/w500${data.profile_path}`
        : null,
      knownForDepartment: data.known_for_department,
    };
  }

  async getPersonCredits(
    externalId: number,
  ): Promise<PersonCombinedCredits> {
    const { data } =
      await this.client.get<TmdbPersonCombinedCreditsResponse>(
        `/person/${externalId}/combined_credits`,
        { params: { language: 'fr-FR' } },
      );
    return {
      cast: data.cast.map((c) => ({
        externalId: c.id,
        title: c.title ?? c.name ?? '',
        mediaType: c.media_type === 'tv' ? 'series' : 'movie',
        character: c.character,
        posterUrl: c.poster_path
          ? `${TMDB_IMAGE_BASE}/w500${c.poster_path}`
          : null,
        releaseDate: c.release_date ?? c.first_air_date ?? null,
        rating: c.vote_average ?? 0,
      })),
      crew: data.crew.map((c) => ({
        externalId: c.id,
        title: c.title ?? c.name ?? '',
        mediaType: c.media_type === 'tv' ? 'series' : 'movie',
        job: c.job,
        department: c.department,
        posterUrl: c.poster_path
          ? `${TMDB_IMAGE_BASE}/w500${c.poster_path}`
          : null,
        releaseDate: c.release_date ?? c.first_air_date ?? null,
        rating: c.vote_average ?? 0,
      })),
    };
  }

  private mapMovieResult(r: TmdbMovieListItem): MetadataSearchResult {
    return {
      tmdbId: r.id,
      title: r.title,
      originalTitle: r.original_title,
      overview: r.overview,
      year: r.release_date ? parseInt(r.release_date) : null,
      posterUrl: r.poster_path
        ? `${TMDB_IMAGE_BASE}/w500${r.poster_path}`
        : null,
      rating: r.vote_average ?? 0,
      genres: [],
      mediaType: 'movie',
    };
  }

  private mapTvResult(r: TmdbTvListItem): MetadataSearchResult {
    return {
      tmdbId: r.id,
      title: r.name,
      originalTitle: r.original_name,
      overview: r.overview,
      year: r.first_air_date ? parseInt(r.first_air_date) : null,
      posterUrl: r.poster_path
        ? `${TMDB_IMAGE_BASE}/w500${r.poster_path}`
        : null,
      rating: r.vote_average ?? 0,
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
    results: {
      iso_3166_1: string;
      release_dates: { type: number; release_date: string }[];
    }[],
  ): {
    inCinemas: string | null;
    digitalRelease: string | null;
    physicalRelease: string | null;
  } {
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
