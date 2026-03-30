import { Repository } from 'typeorm';
import { Media } from './entities/media.entity';
import { Season } from './entities/season.entity';
import { Episode } from './entities/episode.entity';
import { DownloadHistory } from './entities/download-history.entity';
import { Indexer } from '../indexers/entities/indexer.entity';
import { DownloadClient } from '../download-clients/entities/download-client.entity';
import { TorznabService } from '../indexers/torznab.service';
import { QbittorrentService } from '../download-clients/qbittorrent.service';
import { CustomFormatsService } from '../profiles/custom-formats.service';
import { BlocklistService } from '../blocklist/blocklist.service';
import { NotificationsService } from '../notifications/notifications.service';
import { GrabMovieDto } from './dto/grab-movie.dto';
export interface EpisodeReleaseRow {
    title: string;
    downloadUrl: string;
    qualityId: number;
    qualityName: string;
    rank: number;
    allowed: boolean;
    customFormatScore: number;
    blocklisted: boolean;
    indexerId: number;
    indexerName: string;
    languageId: number;
    languageName: string;
    languageAllowed: boolean;
    size: number;
    seeders: number;
    leechers: number;
}
export declare class EpisodeDownloadService {
    private readonly mediaRepo;
    private readonly seasonRepo;
    private readonly episodeRepo;
    private readonly historyRepo;
    private readonly indexerRepo;
    private readonly clientRepo;
    private readonly torznab;
    private readonly qbittorrent;
    private readonly customFormats;
    private readonly blocklist;
    private readonly notifications;
    private readonly log;
    constructor(mediaRepo: Repository<Media>, seasonRepo: Repository<Season>, episodeRepo: Repository<Episode>, historyRepo: Repository<DownloadHistory>, indexerRepo: Repository<Indexer>, clientRepo: Repository<DownloadClient>, torznab: TorznabService, qbittorrent: QbittorrentService, customFormats: CustomFormatsService, blocklist: BlocklistService, notifications: NotificationsService);
    private allowedQualityIds;
    private getEpisodeWithContext;
    searchEpisodeReleases(mediaId: number, episodeId: number): Promise<EpisodeReleaseRow[]>;
    grabEpisode(mediaId: number, episodeId: number, dto?: GrabMovieDto): Promise<DownloadHistory>;
    private buildReleaseRow;
    searchSeasonReleases(mediaId: number, seasonId: number): Promise<EpisodeReleaseRow[]>;
    grabSeason(mediaId: number, seasonId: number, dto?: GrabMovieDto): Promise<{
        grabbed: number;
        errors: string[];
    }>;
}
