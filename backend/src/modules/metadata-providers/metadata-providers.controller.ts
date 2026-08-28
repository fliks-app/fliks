import {
  Controller,
  Get,
  Logger,
  Param,
  Query,
  ServiceUnavailableException,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import axios from 'axios';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { TmdbProvider, DiscoverOptions } from './providers/tmdb.provider';
import { MetadataProviderRegistry } from './metadata-provider.registry';
import { MetadataSearchResult } from './interfaces/metadata-provider.interface';
import { Media } from '../media/entities/media.entity';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';

/** What the upstream actually said: TMDB/TVDB answer a `status_message`, a dead socket
 *  only carries a code, and the breaker carries just its own message. */
function upstreamReason(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const upstream = err.response?.data as
      | { status_message?: string; message?: string }
      | undefined;
    return [
      status ? `HTTP ${status}` : (err.code ?? 'network error'),
      upstream?.status_message ?? upstream?.message ?? err.message,
    ]
      .filter(Boolean)
      .join(' — ');
  }
  return err instanceof Error ? err.message : String(err);
}

@Controller('metadata')
@UseGuards(JwtOrApiKeyGuard)
export class MetadataProvidersController {
  private readonly logger = new Logger(MetadataProvidersController.name);

  constructor(
    private readonly tmdb: TmdbProvider,
    private readonly registry: MetadataProviderRegistry,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
  ) {}

  // ── Search (with provider fallback) ──

  @Get('search/movie')
  async searchMovie(
    @Query('q') q: string,
    @Query('year') year?: string,
    @Query('provider') providerName?: string,
    @Query('mediaId') mediaId?: string,
  ) {
    const query = q?.trim();
    if (!query) return [];
    const results = await this.searchWithFallback(
      providerName ?? (await this.providerPreferredFor(mediaId)),
      (p) => p.searchMovie(query, year ? +year : undefined),
      `movie q="${query}" year=${year ?? '-'}`,
    );
    return this.enrichWithExisting(results, 'movie');
  }

  @Get('search/tv')
  async searchTv(
    @Query('q') q: string,
    @Query('year') year?: string,
    @Query('provider') providerName?: string,
    @Query('mediaId') mediaId?: string,
  ) {
    const query = q?.trim();
    if (!query) return [];
    const results = await this.searchWithFallback(
      providerName ?? (await this.providerPreferredFor(mediaId)),
      (p) => p.searchTvShow(query, year ? +year : undefined),
      `tv q="${query}" year=${year ?? '-'}`,
    );
    return this.enrichWithExisting(results, 'series');
  }

  // ── Trending/Popular (TMDB only) ──

  @Get('trending/movie')
  async trendingMovies(@Query('window') window?: string) {
    const results = await this.tmdb.getTrendingMovies(
      window === 'day' ? 'day' : 'week',
    );
    return this.enrichWithExisting(results, 'movie');
  }

  @Get('popular/movie')
  async popularMovies() {
    const results = await this.tmdb.getPopularMovies();
    return this.enrichWithExisting(results, 'movie');
  }

  @Get('upcoming/movie')
  async upcomingMovies() {
    const results = await this.tmdb.getUpcomingMovies();
    return this.enrichWithExisting(results, 'movie');
  }

  @Get('trending/tv')
  async trendingTv(@Query('window') window?: string) {
    const results = await this.tmdb.getTrendingTvShows(
      window === 'day' ? 'day' : 'week',
    );
    return this.enrichWithExisting(results, 'series');
  }

  // ── Genres + Discover (TMDB /discover) ──

  @Get('genres/movie')
  movieGenres() {
    return this.tmdb.getMovieGenres();
  }

  @Get('genres/tv')
  tvGenres() {
    return this.tmdb.getTvGenres();
  }

  @Get('discover/movie')
  async discoverMovies(
    @Query('genres') genres?: string,
    @Query('sort') sort?: string,
    @Query('voteGte') voteGte?: string,
    @Query('yearGte') yearGte?: string,
    @Query('yearLte') yearLte?: string,
  ) {
    const results = await this.tmdb.discoverMovies(
      this.parseDiscover(genres, sort, voteGte, yearGte, yearLte),
    );
    return this.enrichWithExisting(results, 'movie');
  }

  @Get('discover/tv')
  async discoverTv(
    @Query('genres') genres?: string,
    @Query('sort') sort?: string,
    @Query('voteGte') voteGte?: string,
    @Query('yearGte') yearGte?: string,
    @Query('yearLte') yearLte?: string,
  ) {
    const results = await this.tmdb.discoverTvShows(
      this.parseDiscover(genres, sort, voteGte, yearGte, yearLte),
    );
    return this.enrichWithExisting(results, 'series');
  }

  @Get('popular/tv')
  async popularTv() {
    const results = await this.tmdb.getPopularTvShows();
    return this.enrichWithExisting(results, 'series');
  }

  @Get('upcoming/tv')
  async upcomingTv() {
    const results = await this.tmdb.getUpcomingTvShows();
    return this.enrichWithExisting(results, 'series');
  }

  // ── Details (provider-aware) ──

  @Get(':provider/movie/:externalId')
  async getMovieDetails(
    @Param('provider') providerName: string,
    @Param('externalId') externalId: string,
  ) {
    const provider = this.registry.get(providerName);
    if (!provider)
      throw new BadRequestException(`Unknown provider: ${providerName}`);
    return provider.getMovieDetails(externalId);
  }

  @Get(':provider/tv/:externalId')
  async getTvDetails(
    @Param('provider') providerName: string,
    @Param('externalId') externalId: string,
  ) {
    const provider = this.registry.get(providerName);
    if (!provider)
      throw new BadRequestException(`Unknown provider: ${providerName}`);
    return provider.getTvShowDetails(externalId);
  }

  @Get(':provider/tv/:externalId/seasons')
  async getTvSeasons(
    @Param('provider') providerName: string,
    @Param('externalId') externalId: string,
  ) {
    const provider = this.registry.get(providerName);
    if (!provider)
      throw new BadRequestException(`Unknown provider: ${providerName}`);
    return provider.getTvShowSeasons(externalId);
  }

  // ── Backward compat: /metadata/movie/:id defaults to tmdb ──

  @Get('movie/:tmdbId')
  getMovieDetailsTmdb(@Param('tmdbId') tmdbId: string) {
    return this.tmdb.getMovieDetails(tmdbId);
  }

  @Get('tv/:tmdbId')
  getTvDetailsTmdb(@Param('tmdbId') tmdbId: string) {
    return this.tmdb.getTvShowDetails(tmdbId);
  }

  @Get('tv/:tmdbId/seasons')
  getTvSeasonsTmdb(@Param('tmdbId') tmdbId: string) {
    return this.tmdb.getTvShowSeasons(tmdbId);
  }

  // ── Helpers ──

  /** Parse the raw discover query strings into typed TMDB filter options. */
  private parseDiscover(
    genres?: string,
    sort?: string,
    voteGte?: string,
    yearGte?: string,
    yearLte?: string,
  ): DiscoverOptions {
    const genreIds = (genres ?? '')
      .split(',')
      .map((g) => parseInt(g, 10))
      .filter((n) => Number.isFinite(n));
    return {
      genreIds: genreIds.length ? genreIds : undefined,
      sortBy: sort || undefined,
      voteAverageGte: voteGte ? parseFloat(voteGte) : undefined,
      yearGte: yearGte ? parseInt(yearGte, 10) : undefined,
      yearLte: yearLte ? parseInt(yearLte, 10) : undefined,
    };
  }

  /**
   * Re-identifying a media searches the provider that media is refreshed from,
   * not the global default — same precedence as the metadata service: the
   * media's own override, then its library's. Unknown media resolves to
   * undefined, which `resolve` reads as "no preference".
   */
  private async providerPreferredFor(
    mediaId?: string,
  ): Promise<string | undefined> {
    const id = mediaId ? parseInt(mediaId, 10) : NaN;
    if (!Number.isInteger(id) || id < 1) return undefined;
    const media = await this.mediaRepo.findOne({
      where: { id },
      relations: ['library'],
    });
    return (
      media?.preferredProvider ?? media?.library?.preferredProvider ?? undefined
    );
  }

  private async searchWithFallback(
    providerName: string | undefined,
    searchFn: (p: {
      searchMovie: any;
      searchTvShow: any;
    }) => Promise<MetadataSearchResult[]>,
    label: string,
  ): Promise<MetadataSearchResult[]> {
    const provider = this.registry.resolve(providerName ?? null);
    try {
      let results = await searchFn(provider);

      // Fallback if empty and another provider is available
      if (!results.length) {
        const fallback = this.registry.getFallback(provider.name);
        if (fallback) {
          this.logger.log(
            `Search empty on ${provider.name}, retrying ${fallback.name} — ${label}`,
          );
          results = await searchFn(fallback);
        }
      }
      return results;
    } catch (err) {
      // A raw throw here reaches the client as a bare 500, which says nothing about
      // the key, the quota or the outage that actually caused it.
      const reason = upstreamReason(err);
      this.logger.error(
        `Search failed on ${provider.name} — ${label}: ${reason}`,
        err instanceof Error ? err.stack : undefined,
      );
      throw new ServiceUnavailableException(
        `Metadata search failed on ${provider.name}: ${reason}`,
      );
    }
  }

  private async enrichWithExisting(
    results: MetadataSearchResult[],
    type: string,
  ) {
    if (!results.length) return results;

    // Match by tmdbId or tvdbId
    const tmdbIds = results.map((r) => r.tmdbId).filter((id) => id > 0);
    const tvdbIds = results
      .map((r) => r.tvdbId)
      .filter((id): id is number => !!id && id > 0);

    const conditions: any[] = [];
    if (tmdbIds.length)
      conditions.push({ tmdbId: In(tmdbIds), type: type as any });
    if (tvdbIds.length)
      conditions.push({ tvdbId: In(tvdbIds), type: type as any });

    const existing = conditions.length
      ? await this.mediaRepo.find({
          where: conditions,
          select: ['id', 'tmdbId', 'tvdbId', 'type'],
        })
      : [];

    const tmdbMap = new Map(
      existing
        .filter((m) => m.tmdbId)
        .map((m) => [m.tmdbId, { id: m.id, type: m.type }]),
    );
    const tvdbMap = new Map(
      existing
        .filter((m) => m.tvdbId)
        .map((m) => [m.tvdbId, { id: m.id, type: m.type }]),
    );

    return results.map((r) => {
      const match =
        (r.tmdbId ? tmdbMap.get(r.tmdbId) : undefined) ??
        (r.tvdbId ? tvdbMap.get(r.tvdbId) : undefined);
      return {
        ...r,
        existingMediaId: match?.id ?? null,
        existingMediaType: match?.type ?? null,
      };
    });
  }
}
