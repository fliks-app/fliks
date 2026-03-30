import { DataSource, Repository } from 'typeorm';
import { Indexer } from '../indexers/entities/indexer.entity';
import { DownloadClient } from '../download-clients/entities/download-client.entity';
import { RootFolder } from '../root-folders/entities/root-folder.entity';
import { QbittorrentService } from '../download-clients/qbittorrent.service';
export interface ServiceStatus {
    name: string;
    ok: boolean;
    message?: string;
}
export interface HealthReport {
    version: string;
    uptimeSeconds: number;
    database: ServiceStatus;
    indexers: {
        enabled: number;
        total: number;
    };
    downloadClients: ServiceStatus[];
}
export interface DiskSpaceEntry {
    path: string;
    label: string | null;
    freeSpace: number;
    totalSpace: number;
}
export interface StatsReport {
    movies: number;
    series: number;
    pendingRequests: number;
    diskSpace: DiskSpaceEntry[];
}
export declare class SystemController {
    private readonly dataSource;
    private readonly indexerRepo;
    private readonly clientRepo;
    private readonly rootFolderRepo;
    private readonly qbittorrent;
    constructor(dataSource: DataSource, indexerRepo: Repository<Indexer>, clientRepo: Repository<DownloadClient>, rootFolderRepo: Repository<RootFolder>, qbittorrent: QbittorrentService);
    health(): Promise<HealthReport>;
    private checkDatabase;
    private checkIndexers;
    stats(): Promise<StatsReport>;
    private checkClients;
}
