import { Controller, Get, Param, Query, UseGuards, ParseIntPipe } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { TmdbProvider } from './providers/tmdb.provider';
import { Media } from '../media/entities/media.entity';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';

@Controller('metadata')
@UseGuards(JwtOrApiKeyGuard)
export class MetadataProvidersController {
  constructor(
    private readonly tmdb: TmdbProvider,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
  ) {}

  @Get('search/movie')
  async searchMovie(@Query('q') q: string, @Query('year') year?: string) {
    const query = q?.trim();
    if (!query) return [];
    const results = await this.tmdb.searchMovie(query, year ? +year : undefined);
    return this.enrichWithExisting(results, 'movie');
  }

  @Get('search/tv')
  async searchTv(@Query('q') q: string, @Query('year') year?: string) {
    const query = q?.trim();
    if (!query) return [];
    const results = await this.tmdb.searchTvShow(query, year ? +year : undefined);
    return this.enrichWithExisting(results, 'series');
  }

  @Get('movie/:tmdbId')
  getMovieDetails(@Param('tmdbId', ParseIntPipe) tmdbId: number) {
    return this.tmdb.getMovieDetails(tmdbId);
  }

  @Get('tv/:tmdbId')
  getTvDetails(@Param('tmdbId', ParseIntPipe) tmdbId: number) {
    return this.tmdb.getTvShowDetails(tmdbId);
  }

  @Get('tv/:tmdbId/seasons')
  getTvSeasons(@Param('tmdbId', ParseIntPipe) tmdbId: number) {
    return this.tmdb.getTvShowSeasons(tmdbId);
  }

  private async enrichWithExisting(
    results: { tmdbId: number }[],
    type: string,
  ) {
    if (!results.length) return results;
    const tmdbIds = results.map((r) => r.tmdbId);
    const existing = await this.mediaRepo.find({
      where: { tmdbId: In(tmdbIds), type: type as any },
      select: ['id', 'tmdbId', 'type'],
    });
    const map = new Map(existing.map((m) => [m.tmdbId, { id: m.id, type: m.type }]));
    return results.map((r) => {
      const match = map.get(r.tmdbId);
      return {
        ...r,
        existingMediaId: match?.id ?? null,
        existingMediaType: match?.type ?? null,
      };
    });
  }
}
