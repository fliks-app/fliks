import { BaseEntity } from '../../../common/entities/base.entity';
export declare class LanguageProfile extends BaseEntity {
    name: string;
    cutoff: number;
    languages: LanguageProfileItem[];
}
export interface LanguageProfileItem {
    language: {
        id: number;
        name: string;
        isoCode: string;
    };
    allowed: boolean;
    sortOrder: number;
}
