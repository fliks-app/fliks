import { BaseEntity } from '../../../common/entities/base.entity';
export declare class QualityProfile extends BaseEntity {
    name: string;
    cutoff: number;
    items: QualityProfileItem[];
    upgradeAllowed: boolean;
}
export interface QualityProfileItem {
    quality: {
        id: number;
        name: string;
        resolution: number;
        source: string;
    };
    allowed: boolean;
    sortOrder: number;
}
