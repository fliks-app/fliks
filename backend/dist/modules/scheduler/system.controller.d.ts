import type { Response } from 'express';
import { DataSource, Repository } from 'typeorm';
import { Indexer } from '../indexers/entities/indexer.entity';
import { DownloadClient } from '../download-clients/entities/download-client.entity';
import { RootFolder } from '../root-folders/entities/root-folder.entity';
import { QbittorrentService } from '../download-clients/qbittorrent.service';
import { BackupService } from './backup.service';
import { LogBufferService } from './log-buffer.service';
import { EventsService } from './events.service';
import { ImportRadarrService, ApiImportResult } from './import-radarr.service';
import { ImportSonarrService } from './import-sonarr.service';
import { ImportApiDto } from './dto/import-api.dto';
import { Observable } from 'rxjs';
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
    private readonly backup;
    private readonly logBuffer;
    private readonly eventsService;
    private readonly importRadarrService;
    private readonly importSonarrService;
    constructor(dataSource: DataSource, indexerRepo: Repository<Indexer>, clientRepo: Repository<DownloadClient>, rootFolderRepo: Repository<RootFolder>, qbittorrent: QbittorrentService, backup: BackupService, logBuffer: LogBufferService, eventsService: EventsService, importRadarrService: ImportRadarrService, importSonarrService: ImportSonarrService);
    events(): Observable<MessageEvent>;
    health(): Promise<HealthReport>;
    private checkDatabase;
    private checkIndexers;
    stats(): Promise<StatsReport>;
    createBackup(): Promise<{
        filename: string;
        size: number;
    }>;
    listBackups(): {
        filename: string;
        size: number;
        date: string;
    }[];
    restore(body: {
        filename: string;
    }): Promise<void>;
    downloadBackup(name: string, res: Response): void;
    getLogs(level?: string, q?: string, limit?: string): import("./log-buffer.service").LogEntry[];
    importRadarr(file: Express.Multer.File): Promise<{
        imported: number;
        skipped: number;
        errors: string[];
    }>;
    importSonarr(file: Express.Multer.File): Promise<{
        imported: number;
        skipped: number;
        errors: string[];
    }>;
    importRadarrApi(dto: ImportApiDto): Promise<ApiImportResult>;
    importSonarrApi(dto: ImportApiDto): Promise<ApiImportResult>;
    private checkClients;
}
