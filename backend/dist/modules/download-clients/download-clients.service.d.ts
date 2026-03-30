import { Repository } from 'typeorm';
import { DownloadClient } from './entities/download-client.entity';
import { Tag } from '../tags/entities/tag.entity';
import { DownloadHistory } from '../media/entities/download-history.entity';
import { QbittorrentService, QbittorrentTorrent } from './qbittorrent.service';
import { CreateDownloadClientDto } from './dto/create-download-client.dto';
import { UpdateDownloadClientDto } from './dto/update-download-client.dto';
import { TestDownloadClientDto } from './dto/test-download-client.dto';
export interface QueueEntry extends QbittorrentTorrent {
    clientId: number;
    clientName: string;
    mediaId?: number;
    mediaTitle?: string;
    mediaType?: 'movie' | 'series';
    status: string;
}
export declare class DownloadClientsService {
    private readonly repo;
    private readonly tagRepo;
    private readonly historyRepo;
    private readonly qbittorrent;
    constructor(repo: Repository<DownloadClient>, tagRepo: Repository<Tag>, historyRepo: Repository<DownloadHistory>, qbittorrent: QbittorrentService);
    testConnection(dto: TestDownloadClientDto): Promise<{
        ok: boolean;
        message: string;
    }>;
    create(dto: CreateDownloadClientDto): Promise<DownloadClient>;
    findAll(): Promise<DownloadClient[]>;
    findOne(id: number): Promise<DownloadClient>;
    update(id: number, dto: UpdateDownloadClientDto): Promise<DownloadClient>;
    remove(id: number): Promise<void>;
    removeTorrent(clientId: number, hash: string, deleteFiles: boolean): Promise<void>;
    getQueue(): Promise<QueueEntry[]>;
}
