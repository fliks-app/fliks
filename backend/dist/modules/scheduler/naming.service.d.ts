export declare class NamingService {
    applyMovieFormat(format: string, data: {
        title: string;
        originalTitle?: string;
        year?: number | null;
        quality: string;
        releaseGroup?: string;
        tmdbId?: number | null;
    }): string;
    applySeriesFormat(format: string, data: {
        seriesTitle: string;
        season: number;
        episode: number;
        episodeTitle?: string;
        quality: string;
        releaseGroup?: string;
        airDate?: string | null;
    }): string;
    applySeriesFolderFormat(format: string, data: {
        seriesTitle: string;
        year?: number | null;
        tmdbId?: number | null;
    }): string;
    applySeasonFolderFormat(format: string, data: {
        season: number;
    }): string;
    parseQuality(sourceTitle: string): string;
    extractReleaseGroup(sourceTitle: string): string;
    parseEpisodeNumbers(sourceTitle: string): {
        season: number;
        episode: number;
    } | null;
    findLargestVideoFile(dirPath: string): {
        filePath: string;
        size: number;
    } | null;
    private sanitize;
}
