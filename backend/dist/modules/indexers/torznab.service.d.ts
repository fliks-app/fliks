import { Repository } from 'typeorm';
import { Indexer } from './entities/indexer.entity';
import { IndexerStat } from './entities/indexer-stat.entity';
export interface TorznabRelease {
    title: string;
    downloadUrl: string;
    indexerId: number;
    indexerName: string;
    size: number;
    seeders: number;
    leechers: number;
    publishDate: string | null;
    freeleech: boolean;
    downloadVolumeFactor: number;
}
export declare class TorznabService {
    private readonly statRepo;
    private readonly log;
    constructor(statRepo: Repository<IndexerStat>);
    testConnection(baseUrl: string, apiKey: string): Promise<{
        ok: boolean;
        message: string;
    }>;
    rssSearch(indexer: Indexer): Promise<TorznabRelease[]>;
    searchSeasonPack(indexer: Indexer, showTitle: string, season: number): Promise<TorznabRelease[]>;
    searchSeries(indexer: Indexer, showTitle: string, season: number, episode: number): Promise<TorznabRelease[]>;
    searchMovie(indexer: Indexer, query: string): Promise<TorznabRelease[]>;
}
