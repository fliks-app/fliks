import { Repository } from 'typeorm';
import { TmdbProvider } from './providers/tmdb.provider';
import { Media } from '../media/entities/media.entity';
export declare class MetadataProvidersController {
    private readonly tmdb;
    private readonly mediaRepo;
    constructor(tmdb: TmdbProvider, mediaRepo: Repository<Media>);
    searchMovie(q: string, year?: string): Promise<{
        tmdbId: number;
    }[]>;
    searchTv(q: string, year?: string): Promise<{
        tmdbId: number;
    }[]>;
    getMovieDetails(tmdbId: number): Promise<import("./interfaces/metadata-provider.interface").MetadataDetails>;
    getTvDetails(tmdbId: number): Promise<import("./interfaces/metadata-provider.interface").MetadataDetails>;
    getTvSeasons(tmdbId: number): Promise<import("./interfaces/metadata-provider.interface").SeasonDetails[]>;
    private enrichWithExisting;
}
