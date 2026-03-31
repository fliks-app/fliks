import { Client } from 'pg';
import type { ConfigService } from '@nestjs/config';
export declare function isCustomPgDumpFormat(buf: Buffer): boolean;
export declare function withTemporaryRestoredDatabase(config: ConfigService, fileBuffer: Buffer, run: (client: Client) => Promise<void>): Promise<void>;
export declare function rowMonitored(v: unknown): boolean;
export declare function queryRadarrMovies(client: Client): Promise<Array<{
    title: string;
    tmdbId: number;
    year: number | null;
    path: string | null;
    monitored: unknown;
}>>;
export declare function querySonarrSeries(client: Client): Promise<Array<{
    title: string;
    externalId: number;
    year: number | null;
    path: string | null;
    monitored: unknown;
}>>;
