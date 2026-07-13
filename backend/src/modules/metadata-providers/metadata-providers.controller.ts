import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { TmdbProvider, DiscoverOptions } from './providers/tmdb.provider';
import { MetadataProviderRegistry } from './metadata-provider.registry';
import { MetadataSearchResult } from './interfaces/metadata-provider.interface';
import { Media } from '../media/entities/media.entity';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';

@Controller('metadata')
@UseGuards(JwtOrApiKeyGuard)
export class MetadataProvidersController {
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
  ) {
    const query = q?.trim();
    if (!query) return [];
    const results = await this.searchWithFallback(providerName, (p) =>
      p.searchMovie(query, year ? +year : undefined),
    );
    return this.enrichWithExisting(results, 'movie');
  }

  @Get('search/tv')
  async searchTv(
    @Query('q') q: string,
    @Query('year') year?: string,
    @Query('provider') providerName?: string,
  ) {
    const query = q?.trim();
    if (!query) return [];
    const results = await this.searchWithFallback(providerName, (p) =>
      p.searchTvShow(query, year ? +year : undefined),
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

  private async searchWithFallback(
    providerName: string | undefined,
    searchFn: (p: {
      searchMovie: any;
      searchTvShow: any;
    }) => Promise<MetadataSearchResult[]>,
  ): Promise<MetadataSearchResult[]> {
    const provider = this.registry.resolve(providerName ?? null);
    let results = await searchFn(provider);

    // Fallback if empty and another provider is available
    if (!results.length) {
      const fallback = this.registry.getFallback(provider.name);
      if (fallback) {
        results = await searchFn(fallback);
      }
    }
    return results;
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
