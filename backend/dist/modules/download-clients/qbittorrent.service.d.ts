import { DownloadClient } from './entities/download-client.entity';
export interface QbittorrentTorrent {
    hash: string;
    name: string;
    size: number;
    downloaded: number;
    progress: number;
    dlspeed: number;
    upspeed: number;
    eta: number;
    state: string;
    category: string;
    num_seeds: number;
    num_leechs: number;
    added_on: number;
    completion_on: number;
    save_path: string;
}
export declare class QbittorrentService {
    private readonly log;
    private buildBaseUrl;
    testConnection(settings: Record<string, unknown>): Promise<{
        ok: boolean;
        message: string;
    }>;
    getTorrents(client: DownloadClient): Promise<QbittorrentTorrent[]>;
    deleteTorrent(client: DownloadClient, hash: string, deleteFiles?: boolean): Promise<void>;
    supports(client: DownloadClient): boolean;
    private sanitizeUrl;
    addTorrentUrl(client: DownloadClient, torrentUrl: string, mediaType?: 'movie' | 'series'): Promise<void>;
}
