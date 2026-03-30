export interface SuitarrQualityDefinition {
    id: number;
    name: string;
    resolution: number;
    source: string;
    rank: number;
}
export declare const SUITARR_QUALITIES: SuitarrQualityDefinition[];
export declare function getSuitarrQualityById(id: number): SuitarrQualityDefinition | undefined;
export declare const DEFAULT_MOVIE_QUALITY_PROFILE_NAME = "HD-1080p (d\u00E9faut)";
