import { DataSource, Repository } from 'typeorm';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { DownloadHistory } from '../media/entities/download-history.entity';
import { Season } from '../media/entities/season.entity';
import { Episode } from '../media/entities/episode.entity';
import { DownloadClient } from '../download-clients/entities/download-client.entity';
import { RootFolder } from '../root-folders/entities/root-folder.entity';
import { QbittorrentService } from '../download-clients/qbittorrent.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NamingService } from './naming.service';
export declare class CompletionService {
    private readonly dataSource;
    private readonly mediaRepo;
    private readonly mediaFileRepo;
    private readonly historyRepo;
    private readonly seasonRepo;
    private readonly episodeRepo;
    private readonly clientRepo;
    private readonly rootFolderRepo;
    private readonly qbittorrent;
    private readonly notifications;
    private readonly naming;
    private readonly log;
    constructor(dataSource: DataSource, mediaRepo: Repository<Media>, mediaFileRepo: Repository<MediaFile>, historyRepo: Repository<DownloadHistory>, seasonRepo: Repository<Season>, episodeRepo: Repository<Episode>, clientRepo: Repository<DownloadClient>, rootFolderRepo: Repository<RootFolder>, qbittorrent: QbittorrentService, notifications: NotificationsService, naming: NamingService);
    processCompleted(): Promise<void>;
    private processOne;
}
