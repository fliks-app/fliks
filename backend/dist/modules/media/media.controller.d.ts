import { MediaService } from './media.service';
import { MovieDownloadService } from './movie-download.service';
import { EpisodeDownloadService } from './episode-download.service';
import { DiskImportService } from './disk-import.service';
import { CreateMediaDto } from './dto/create-media.dto';
import { UpdateMediaDto } from './dto/update-media.dto';
import { SearchMediaDto } from './dto/search-media.dto';
import { ImportTmdbDto } from './dto/import-tmdb.dto';
import { GrabMovieDto } from './dto/grab-movie.dto';
import { ScanFolderDto } from './dto/scan-folder.dto';
import { ConfirmDiskImportDto } from './dto/confirm-disk-import.dto';
import { UpdateMediaProfilesDto } from './dto/update-media-profiles.dto';
import { BulkUpdateMediaDto } from './dto/bulk-update-media.dto';
import { CalendarQueryDto } from './dto/calendar-query.dto';
import { HistoryQueryDto } from './dto/history-query.dto';
import { PatchMonitoredDto } from './dto/patch-monitored.dto';
import { UpdatePathDto } from './dto/update-path.dto';
import { LinkTorrentDto } from './dto/link-torrent.dto';
import { Media } from './entities/media.entity';
export declare class MediaController {
    private readonly mediaService;
    private readonly movieDownload;
    private readonly episodeDownload;
    private readonly diskImport;
    constructor(mediaService: MediaService, movieDownload: MovieDownloadService, episodeDownload: EpisodeDownloadService, diskImport: DiskImportService);
    importFromTmdb(dto: ImportTmdbDto): Promise<Media>;
    diskScan(dto: ScanFolderDto): Promise<import("./disk-import.service").ScanCandidate[]>;
    diskConfirm(dto: ConfirmDiskImportDto): Promise<{
        imported: number;
        errors: string[];
    }>;
    create(dto: CreateMediaDto): Promise<Media>;
    findAll(query: SearchMediaDto): Promise<{
        data: Media[];
        total: number;
    }>;
    suitarrQualities(): import("../../common/constants/suitarr-qualities").SuitarrQualityDefinition[];
    calendar(query: CalendarQueryDto): Promise<{
        id: number;
        mediaId: number;
        title: string;
        type: "movie" | "series";
        event: string;
        date: string;
        posterUrl: string | null;
        status: string;
        year: number;
        seasonNumber?: number;
        episodeNumber?: number;
        episodeTitle?: string;
        hasFile?: boolean;
    }[]>;
    history(query: HistoryQueryDto): Promise<{
        data: Record<string, unknown>[];
        total: number;
    }>;
    deleteHistory(id: number): Promise<void>;
    linkTorrent(dto: LinkTorrentDto): Promise<import("./entities/download-history.entity").DownloadHistory>;
    retryImport(id: number): Promise<void>;
    bulkUpdate(dto: BulkUpdateMediaDto): Promise<{
        updated: number;
    }>;
    renameFiles(id: number): Promise<{
        renamed: number;
    }>;
    movieReleases(id: number, customQuery?: string): Promise<import("./movie-download.service").MovieReleaseRow[]>;
    grabMovie(id: number, dto: GrabMovieDto): Promise<import("./entities/download-history.entity").DownloadHistory>;
    upgradeReleases(id: number, customQuery?: string): Promise<import("./movie-download.service").MovieReleaseRow[]>;
    grabUpgrade(id: number, dto: GrabMovieDto): Promise<import("./entities/download-history.entity").DownloadHistory>;
    seasonReleases(id: number, seasonId: number, customQuery?: string): Promise<import("./episode-download.service").EpisodeReleaseRow[]>;
    grabSeason(id: number, seasonId: number, dto: GrabMovieDto): Promise<{
        grabbed: number;
        errors: string[];
    }>;
    episodeReleases(id: number, episodeId: number, customQuery?: string): Promise<import("./episode-download.service").EpisodeReleaseRow[]>;
    grabEpisode(id: number, episodeId: number, dto: GrabMovieDto): Promise<import("./entities/download-history.entity").DownloadHistory>;
    deleteFile(id: number, fileId: number, deleteOnDisk?: string): Promise<void>;
    updatePath(id: number, dto: UpdatePathDto): Promise<Media>;
    updateProfiles(id: number, dto: UpdateMediaProfilesDto): Promise<Media>;
    refreshMetadata(id: number): Promise<Media>;
    findOne(id: number): Promise<Media>;
    update(id: number, dto: UpdateMediaDto): Promise<Media>;
    remove(id: number): Promise<void>;
    patchSeason(seasonId: number, dto: PatchMonitoredDto): Promise<import("./entities/season.entity").Season>;
    patchEpisode(episodeId: number, dto: PatchMonitoredDto): Promise<import("./entities/episode.entity").Episode>;
}
