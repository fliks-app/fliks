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
  ExternalIdResult,
} from '../interfaces/metadata-provider.interface';
import type {
  TmdbImages,
  TmdbMovieDetailsResponse,
  TmdbMovieListItem,
  TmdbPaginated,
  TmdbTvDetailsResponse,
  TmdbTvEpisode,
  TmdbTvListItem,
  TmdbTvSeasonResponse,
  TmdbTvShowWithSeasons,
  TmdbGenre,
  TmdbPersonDetailsResponse,
  TmdbPersonCombinedCreditsResponse,
} from './tmdb-api.types';
import {
  MetadataSettingsCache,
  MetadataLanguageOverride,
} from '../metadata-settings-cache.service';
import { installCircuitBreaker } from '../http-circuit-breaker';

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

/** Cap on how many extra fanarts we keep per media. Each entry is
 *  downloaded at thumb + medium + full → ~3× storage per item, so 5
 *  stays under ~10 MB per series even with high-res sources. */
const MAX_ADDITIONAL_FANARTS = 5;

/**
 * Pick the top `n` fanart URLs from a TMDB images response,
 * skipping the one already used as the primary `fanartUrl` so the
 * background rotation doesn't repeat it. Sorted by `vote_average`
 * descending — TMDB's community-voted score is a decent proxy for
 * "looks good as a backdrop".
 */
function pickAdditionalFanarts(
  images: TmdbImages | undefined,
  primaryPath: string | null | undefined,
  n: number,
): string[] {
  const candidates = (images?.backdrops ?? [])
    .filter((b) => b.file_path && b.file_path !== primaryPath)
    .sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0))
    .slice(0, n);
  return candidates.map((b) => `${TMDB_IMAGE_BASE}/original${b.file_path}`);
}

/**
 * Pick the best "clearlogo" from a TMDB images payload. Logos are
 * language-tagged transparent PNGs; prefer `preferIso1`, then English, then a
 * language-neutral / any logo, breaking ties on the community vote. Returns
 * the original-size URL (the PNG keeps its transparency) or null when the
 * title has no logo. Requires the details request to set
 * `include_image_language` so logos beyond the `language` locale are returned.
 */
function pickLogo(
  images: TmdbImages | undefined,
  preferIso1: string,
): string | null {
  const logos = (images?.logos ?? []).filter((l) => l.file_path);
  if (!logos.length) return null;
  // Community vote is the best proxy for "the clean official title logo":
  // promotional banners (cast names, "in theatres" dates) get uploaded but
  // rarely upvoted, so they sink below the real logo. Language only adds a
  // small bonus that tips otherwise-close calls toward the user's locale —
  // never enough to override a clearly better-voted logo in another language.
  const langBonus = (lang: string | null | undefined): number =>
    lang === preferIso1 ? 0.5 : lang === 'en' ? 0.25 : 0;
  const score = (l: { vote_average?: number; iso_639_1?: string | null }): number =>
    (l.vote_average ?? 0) + langBonus(l.iso_639_1);
  const best = [...logos].sort((a, b) => score(b) - score(a))[0];
  return `${TMDB_IMAGE_BASE}/original${best.file_path}`;
}

/**
 * Pull alternative_titles out of a TMDB movie / tv details response.
 * The two endpoints differ on field name (`titles` vs `results`) and item
 * key (`title` vs `name`). Output is deduplicated against `data.title /
 * data.name` and `data.original_title / data.original_name` so callers
 * don't have to filter again.
 */
function extractAlternativeTitles(
  data: TmdbMovieDetailsResponse | TmdbTvDetailsResponse,
  kind: 'movie' | 'series',
): string[] {
  const raw =
    kind === 'movie'
      ? ((data as TmdbMovieDetailsResponse).alternative_titles?.titles ?? [])
      : ((data as TmdbTvDetailsResponse).alternative_titles?.results ?? []);
  const primary =
    kind === 'movie'
      ? (data as TmdbMovieDetailsResponse).title
      : (data as TmdbTvDetailsResponse).name;
  const original =
    kind === 'movie'
      ? (data as TmdbMovieDetailsResponse).original_title
      : (data as TmdbTvDetailsResponse).original_name;
  const seen = new Set<string>(
    [primary, original]
      .filter((s): s is string => !!s)
      .map((s) => s.toLowerCase()),
  );
  const out: string[] = [];
  for (const entry of raw as { title?: string; name?: string }[]) {
    const t = (entry.title ?? entry.name ?? '').trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** TMDB /discover filters (V1 subset). */
export interface DiscoverOptions {
  genreIds?: number[];
  sortBy?: string;
  voteAverageGte?: number;
  yearGte?: number;
  yearLte?: number;
}

@Injectable()
export class TmdbProvider implements IMetadataProvider {
  readonly name = 'tmdb';
  readonly supportsPersonLookup = true;
  private readonly client: AxiosInstance;
  private readonly logger = new Logger(TmdbProvider.name);

  constructor(
    private readonly config: ConfigService,
    private readonly metaLang: MetadataSettingsCache,
  ) {
    this.client = axios.create({
      baseURL: 'https://api.themoviedb.org/3',
      params: { api_key: this.config.get<string>('TMDB_API_KEY', '') },
      timeout: 10000,
    });
    // A TMDB/CloudFront outage otherwise makes every call hang for the full
    // timeout; fail fast once it's clearly down and stop reprobing it per item.
    installCircuitBreaker(this.client, {
      name: 'tmdb',
      failureThreshold: 3,
      cooldownMs: 30_000,
    });
  }

  /** Last successful payload per global list key, served when a live fetch
   *  fails so a TMDB outage empties nothing that was ever loaded. */
  private readonly listFallback = new Map<string, unknown>();

  /** Fetch a global (non-user-specific) TMDB list, falling back to the last
   *  good copy on failure. Cold misses propagate — there is nothing to serve. */
  private async withStaleFallback<T>(
    key: string,
    fetch: () => Promise<T>,
  ): Promise<T> {
    try {
      const value = await fetch();
      this.listFallback.set(key, value);
      return value;
    } catch (err) {
      if (this.listFallback.has(key)) {
        this.logger.warn(`TMDB ${key} unavailable — serving last cached copy`);
        return this.listFallback.get(key) as T;
      }
      throw err;
    }
  }

  async searchMovie(
    query: string,
    year?: number,
  ): Promise<MetadataSearchResult[]> {
    const lang = await this.metaLang.resolve();
    const params: Record<string, unknown> = {
      query,
      language: lang.tmdbLocale,
    };
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
    const lang = await this.metaLang.resolve();
    const params: Record<string, unknown> = {
      query,
      language: lang.tmdbLocale,
    };
    if (year) params.first_air_date_year = year;

    const { data } = await this.client.get<TmdbPaginated<TmdbTvListItem>>(
      '/search/tv',
      { params },
    );
    return data.results.map((r) => this.mapTvResult(r));
  }

  async getMovieDetails(
    externalId: string,
    override?: MetadataLanguageOverride,
  ): Promise<MetadataDetails> {
    const lang = await this.metaLang.resolve(override);
    const tmdbId = parseInt(externalId, 10);
    const { data } = await this.client.get<TmdbMovieDetailsResponse>(
      `/movie/${tmdbId}`,
      {
        params: {
          language: lang.tmdbLocale,
          // Logos are language-tagged; request the configured language + en +
          // language-neutral so pickLogo has fallbacks beyond the `language`
          // locale.
          include_image_language: lang.includeImageLanguage,
          append_to_response:
            'external_ids,images,release_dates,credits,videos,keywords,alternative_titles',
        },
      },
    );

    const dates = this.extractReleaseDates(
      data.release_dates?.results ?? [],
      lang.releaseDatePriority,
    );

    return {
      tmdbId: data.id,
      tvdbId: null,
      seasonCount: null,
      episodeCount: null,
      imdbId: data.external_ids?.imdb_id ?? data.imdb_id ?? null,
      provider: 'tmdb',
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
      logoUrl: pickLogo(data.images, lang.logoIso1),
      additionalFanartUrls: pickAdditionalFanarts(
        data.images,
        data.backdrop_path,
        MAX_ADDITIONAL_FANARTS,
      ),
      rating: data.vote_average ?? 0,
      genres: data.genres?.map((g: TmdbGenre) => g.name) ?? [],
      genreIds: data.genres?.map((g: TmdbGenre) => g.id) ?? [],
      mediaType: 'movie',
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
      alternativeTitles: extractAlternativeTitles(data, 'movie'),
      tmdbCollectionId: data.belongs_to_collection?.id ?? null,
      tmdbCollectionName: data.belongs_to_collection?.name ?? null,
    };
  }

  async getTvShowDetails(
    externalId: string,
    override?: MetadataLanguageOverride,
  ): Promise<MetadataDetails> {
    const lang = await this.metaLang.resolve(override);
    const tmdbId = parseInt(externalId, 10);
    const { data } = await this.client.get<TmdbTvDetailsResponse>(
      `/tv/${tmdbId}`,
      {
        params: {
          language: lang.tmdbLocale,
          // Logos are language-tagged; request the configured language + en +
          // language-neutral so pickLogo has fallbacks beyond the `language`
          // locale.
          include_image_language: lang.includeImageLanguage,
          append_to_response:
            'external_ids,images,credits,videos,keywords,alternative_titles',
        },
      },
    );
    return {
      tmdbId: data.id,
      tvdbId: (data.external_ids as any)?.tvdb_id ?? null,
      imdbId: data.external_ids?.imdb_id ?? null,
      provider: 'tmdb',
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
      logoUrl: pickLogo(data.images, lang.logoIso1),
      additionalFanartUrls: pickAdditionalFanarts(
        data.images,
        data.backdrop_path,
        MAX_ADDITIONAL_FANARTS,
      ),
      rating: data.vote_average ?? 0,
      genres: data.genres?.map((g: TmdbGenre) => g.name) ?? [],
      genreIds: data.genres?.map((g: TmdbGenre) => g.id) ?? [],
      mediaType: 'series',
      runtime: data.episode_run_time?.[0] ?? null,
      seasonCount: data.number_of_seasons ?? null,
      episodeCount: data.number_of_episodes ?? null,
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
      alternativeTitles: extractAlternativeTitles(data, 'series'),
      tmdbCollectionId: null,
      tmdbCollectionName: null,
    };
  }

  /**
   * Saisons + nombre d'épisodes (un seul appel API), pour import bibliothèque sans N requêtes /season.
   */
  async getTvSeasonStubs(
    externalId: string,
  ): Promise<{ seasonNumber: number; episodeCount: number }[]> {
    const lang = await this.metaLang.resolve();
    const tmdbId = parseInt(externalId, 10);
    const { data: show } = await this.client.get<TmdbTvShowWithSeasons>(
      `/tv/${tmdbId}`,
      {
        params: { language: lang.tmdbLocale },
      },
    );
    return (show.seasons ?? [])
      .filter((s) => s.season_number > 0)
      .map((s) => ({
        seasonNumber: s.season_number,
        episodeCount: s.episode_count ?? 0,
      }));
  }

  async getTvSeason(
    externalId: string,
    seasonNumber: number,
    override?: MetadataLanguageOverride,
  ): Promise<SeasonDetails> {
    const lang = await this.metaLang.resolve(override);
    const tmdbId = parseInt(externalId, 10);
    const { data: season } = await this.client.get<TmdbTvSeasonResponse>(
      `/tv/${tmdbId}/season/${seasonNumber}`,
      { params: { language: lang.tmdbLocale } },
    );
    return {
      seasonNumber: season.season_number,
      episodeCount: season.episodes?.length ?? 0,
      overview: season.overview || null,
      airDate: season.air_date || null,
      posterUrl: season.poster_path
        ? `${TMDB_IMAGE_BASE}/w500${season.poster_path}`
        : null,
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
    };
  }

  async getTvShowSeasons(
    externalId: string,
    override?: MetadataLanguageOverride,
  ): Promise<SeasonDetails[]> {
    const lang = await this.metaLang.resolve(override);
    const tmdbId = parseInt(externalId, 10);
    const { data: show } = await this.client.get<TmdbTvShowWithSeasons>(
      `/tv/${tmdbId}`,
      {
        params: { language: lang.tmdbLocale },
      },
    );

    const seasons: SeasonDetails[] = [];
    for (const s of show.seasons ?? []) {
      if (s.season_number === 0) continue;
      try {
        const { data: season } = await this.client.get<TmdbTvSeasonResponse>(
          `/tv/${tmdbId}/season/${s.season_number}`,
          { params: { language: lang.tmdbLocale } },
        );
        seasons.push({
          seasonNumber: season.season_number,
          episodeCount: season.episodes?.length ?? 0,
          overview: season.overview || null,
          airDate: season.air_date || null,
          posterUrl: season.poster_path
            ? `${TMDB_IMAGE_BASE}/w500${season.poster_path}`
            : null,
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

  async getTrendingMovies(
    window: 'day' | 'week' = 'week',
  ): Promise<MetadataSearchResult[]> {
    const lang = await this.metaLang.resolve();
    return this.withStaleFallback(
      `trending:movie:${window}:${lang.tmdbLocale}`,
      async () => {
        const { data } = await this.client.get<
          TmdbPaginated<TmdbMovieListItem>
        >(`/trending/movie/${window}`, {
          params: { language: lang.tmdbLocale },
        });
        return data.results.map((r) => this.mapMovieResult(r));
      },
    );
  }

  async getPopularMovies(): Promise<MetadataSearchResult[]> {
    const lang = await this.metaLang.resolve();
    return this.withStaleFallback(
      `popular:movie:${lang.tmdbLocale}`,
      async () => {
        const { data } = await this.client.get<
          TmdbPaginated<TmdbMovieListItem>
        >('/movie/popular', { params: { language: lang.tmdbLocale } });
        return data.results.map((r) => this.mapMovieResult(r));
      },
    );
  }

  async getUpcomingMovies(): Promise<MetadataSearchResult[]> {
    const lang = await this.metaLang.resolve();
    return this.withStaleFallback(
      `upcoming:movie:${lang.tmdbLocale}:${lang.region}`,
      async () => {
        const { data } = await this.client.get<
          TmdbPaginated<TmdbMovieListItem>
        >('/movie/upcoming', {
          params: { language: lang.tmdbLocale, region: lang.region },
        });
        return data.results.map((r) => this.mapMovieResult(r));
      },
    );
  }

  async getTrendingTvShows(
    window: 'day' | 'week' = 'week',
  ): Promise<MetadataSearchResult[]> {
    const lang = await this.metaLang.resolve();
    return this.withStaleFallback(
      `trending:tv:${window}:${lang.tmdbLocale}`,
      async () => {
        const { data } = await this.client.get<TmdbPaginated<TmdbTvListItem>>(
          `/trending/tv/${window}`,
          { params: { language: lang.tmdbLocale } },
        );
        return data.results.map((r) => this.mapTvResult(r));
      },
    );
  }

  async getPopularTvShows(): Promise<MetadataSearchResult[]> {
    const lang = await this.metaLang.resolve();
    return this.withStaleFallback(`popular:tv:${lang.tmdbLocale}`, async () => {
      const { data } = await this.client.get<TmdbPaginated<TmdbTvListItem>>(
        '/tv/popular',
        { params: { language: lang.tmdbLocale } },
      );
      return data.results.map((r) => this.mapTvResult(r));
    });
  }

  async getUpcomingTvShows(): Promise<MetadataSearchResult[]> {
    const lang = await this.metaLang.resolve();
    return this.withStaleFallback(`upcoming:tv:${lang.tmdbLocale}`, async () => {
      const { data } = await this.client.get<TmdbPaginated<TmdbTvListItem>>(
        '/tv/on_the_air',
        { params: { language: lang.tmdbLocale } },
      );
      return data.results.map((r) => this.mapTvResult(r));
    });
  }

  async getMovieGenres(): Promise<{ id: number; name: string }[]> {
    const lang = await this.metaLang.resolve();
    return this.withStaleFallback(`genres:movie:${lang.tmdbLocale}`, async () => {
      const { data } = await this.client.get<{
        genres: { id: number; name: string }[];
      }>('/genre/movie/list', { params: { language: lang.tmdbLocale } });
      return data.genres;
    });
  }

  async getTvGenres(): Promise<{ id: number; name: string }[]> {
    const lang = await this.metaLang.resolve();
    return this.withStaleFallback(`genres:tv:${lang.tmdbLocale}`, async () => {
      const { data } = await this.client.get<{
        genres: { id: number; name: string }[];
      }>('/genre/tv/list', { params: { language: lang.tmdbLocale } });
      return data.genres;
    });
  }

  async discoverMovies(opts: DiscoverOptions): Promise<MetadataSearchResult[]> {
    const lang = await this.metaLang.resolve();
    const params: Record<string, string | number> = {
      language: lang.tmdbLocale,
      include_adult: 'false',
      sort_by: opts.sortBy || 'popularity.desc',
      // Keep obscure entries out of popularity/date sorts.
      'vote_count.gte': 50,
    };
    if (opts.genreIds?.length) params['with_genres'] = opts.genreIds.join(',');
    if (opts.voteAverageGte) params['vote_average.gte'] = opts.voteAverageGte;
    if (opts.yearGte) params['primary_release_date.gte'] = `${opts.yearGte}-01-01`;
    if (opts.yearLte) params['primary_release_date.lte'] = `${opts.yearLte}-12-31`;
    const { data } = await this.client.get<TmdbPaginated<TmdbMovieListItem>>(
      '/discover/movie',
      { params },
    );
    return data.results.map((r) => this.mapMovieResult(r));
  }

  async discoverTvShows(opts: DiscoverOptions): Promise<MetadataSearchResult[]> {
    const lang = await this.metaLang.resolve();
    // TMDB /discover/tv dates its sort on first_air_date, not release date.
    const sortBy = (opts.sortBy || 'popularity.desc').replace(
      'primary_release_date',
      'first_air_date',
    );
    const params: Record<string, string | number> = {
      language: lang.tmdbLocale,
      sort_by: sortBy,
      'vote_count.gte': 50,
    };
    if (opts.genreIds?.length) params['with_genres'] = opts.genreIds.join(',');
    if (opts.voteAverageGte) params['vote_average.gte'] = opts.voteAverageGte;
    if (opts.yearGte) params['first_air_date.gte'] = `${opts.yearGte}-01-01`;
    if (opts.yearLte) params['first_air_date.lte'] = `${opts.yearLte}-12-31`;
    const { data } = await this.client.get<TmdbPaginated<TmdbTvListItem>>(
      '/discover/tv',
      { params },
    );
    return data.results.map((r) => this.mapTvResult(r));
  }

  async getPersonDetails(externalId: string): Promise<PersonDetails> {
    const lang = await this.metaLang.resolve();
    const id = parseInt(externalId, 10);
    const { data } = await this.client.get<TmdbPersonDetailsResponse>(
      `/person/${id}`,
      { params: { language: lang.tmdbLocale } },
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

  async getPersonCredits(externalId: string): Promise<PersonCombinedCredits> {
    const lang = await this.metaLang.resolve();
    const id = parseInt(externalId, 10);
    const { data } = await this.client.get<TmdbPersonCombinedCreditsResponse>(
      `/person/${id}/combined_credits`,
      { params: { language: lang.tmdbLocale } },
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

  /**
   * Find a movie/series on TMDB by external ID (IMDB, TVDB).
   */
  async findByExternalId(
    source: string,
    id: string,
    override?: MetadataLanguageOverride,
  ): Promise<ExternalIdResult | null> {
    const sourceMap: Record<string, string> = {
      imdb: 'imdb_id',
      tvdb: 'tvdb_id',
    };
    const externalSource = sourceMap[source];
    if (!externalSource) return null;

    const lang = await this.metaLang.resolve(override);
    const { data } = await this.client.get<any>(`/find/${id}`, {
      params: { external_source: externalSource, language: lang.tmdbLocale },
    });

    const movie = data.movie_results?.[0];
    if (movie) return { id: String(movie.id), mediaType: 'movie' };

    const tv = data.tv_results?.[0];
    if (tv) return { id: String(tv.id), mediaType: 'series' };

    return null;
  }

  private mapMovieResult(r: TmdbMovieListItem): MetadataSearchResult {
    return {
      tmdbId: r.id,
      provider: 'tmdb',
      title: r.title,
      originalTitle: r.original_title,
      overview: r.overview,
      year: r.release_date ? parseInt(r.release_date) : null,
      posterUrl: r.poster_path
        ? `${TMDB_IMAGE_BASE}/w500${r.poster_path}`
        : null,
      rating: r.vote_average ?? 0,
      genres: [],
      genreIds: r.genre_ids ?? [],
      mediaType: 'movie',
    };
  }

  private mapTvResult(r: TmdbTvListItem): MetadataSearchResult {
    return {
      tmdbId: r.id,
      provider: 'tmdb',
      title: r.name,
      originalTitle: r.original_name,
      overview: r.overview,
      year: r.first_air_date ? parseInt(r.first_air_date) : null,
      posterUrl: r.poster_path
        ? `${TMDB_IMAGE_BASE}/w500${r.poster_path}`
        : null,
      rating: r.vote_average ?? 0,
      genres: [],
      genreIds: r.genre_ids ?? [],
      mediaType: 'series',
    };
  }

  /**
   * Extract cinema, digital, and physical release dates from TMDB release_dates.
   */
  private extractReleaseDates(
    results: {
      iso_3166_1: string;
      release_dates: { type: number; release_date: string }[];
    }[],
    priority: string[],
  ): {
    inCinemas: string | null;
    digitalRelease: string | null;
    physicalRelease: string | null;
  } {
    const dates: Record<number, string> = {};

    const sorted = [...results].sort((a, b) => {
      const ai = priority.indexOf(a.iso_3166_1);
      const bi = priority.indexOf(b.iso_3166_1);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    // Countries are in priority order, so the first one carrying a given
    // release type wins; lower-priority countries only fill types the higher
    // ones lack.
    for (const country of sorted) {
      for (const rd of country.release_dates) {
        if (!rd.release_date || dates[rd.type]) continue;
        dates[rd.type] = rd.release_date.slice(0, 10);
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
