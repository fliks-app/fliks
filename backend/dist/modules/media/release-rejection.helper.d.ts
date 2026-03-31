import { QualityProfileItem } from '../profiles/entities/quality-profile.entity';
import { Indexer } from '../indexers/entities/indexer.entity';
export interface ReleaseRejection {
    code: string;
    params?: Record<string, number | string>;
}
export interface SizeLimits {
    min: number;
    preferred: number;
    max: number;
}
export declare function buildAllowedQualityIds(items: QualityProfileItem[] | undefined): Set<number>;
export declare function buildIndexerMinSeeders(indexers: Indexer[]): Map<number, number>;
export declare function computeRejections(opts: {
    qualityId: number;
    allowed: Set<number>;
    languageId: number;
    allowedLangs: Set<number>;
    isBlocklisted: boolean;
    sizeBytes: number;
    sizeByQuality: Map<number, SizeLimits>;
    seeders: number;
    indexerId: number;
    indexerMinSeeders: Map<number, number>;
}): ReleaseRejection[];
