import { ConfigService } from '@nestjs/config';
import { IMetadataProvider, MetadataSearchResult, MetadataDetails, SeasonDetails } from '../interfaces/metadata-provider.interface';
export declare class TmdbProvider implements IMetadataProvider {
    private readonly config;
    readonly name = "tmdb";
    private readonly client;
    private readonly logger;
    constructor(config: ConfigService);
    searchMovie(query: string, year?: number): Promise<MetadataSearchResult[]>;
    searchTvShow(query: string, year?: number): Promise<MetadataSearchResult[]>;
    getMovieDetails(tmdbId: number): Promise<MetadataDetails>;
    getTvShowDetails(tmdbId: number): Promise<MetadataDetails>;
    getTvSeasonStubs(tmdbId: number): Promise<{
        seasonNumber: number;
        episodeCount: number;
    }[]>;
    getTvShowSeasons(tmdbId: number): Promise<SeasonDetails[]>;
    getTrendingMovies(): Promise<MetadataSearchResult[]>;
    getPopularMovies(): Promise<MetadataSearchResult[]>;
    getUpcomingMovies(): Promise<MetadataSearchResult[]>;
    getTrendingTvShows(): Promise<MetadataSearchResult[]>;
    getPopularTvShows(): Promise<MetadataSearchResult[]>;
    getUpcomingTvShows(): Promise<MetadataSearchResult[]>;
    private mapMovieResult;
    private mapTvResult;
    private extractReleaseDates;
    private mapTvStatus;
}
