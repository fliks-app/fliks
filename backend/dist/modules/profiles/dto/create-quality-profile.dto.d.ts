export declare class QualityItemDto {
    qualityId: number;
    qualityName: string;
    resolution: number;
    source: string;
    allowed: boolean;
    sortOrder: number;
    groupId?: number;
}
export declare class CreateQualityProfileDto {
    name: string;
    cutoff: number;
    upgradeAllowed?: boolean;
    items: QualityItemDto[];
}
