import { MediaType, MediaStatus } from '../../../common/enums';
export declare class SearchMediaDto {
    q?: string;
    type?: MediaType;
    status?: MediaStatus;
    monitored?: boolean;
    year?: number;
    genre?: string;
    tagId?: number;
    qualityProfileId?: number;
    languageProfileId?: number;
    sortBy?: string;
    sortOrder?: 'ASC' | 'DESC';
    page?: number;
    limit?: number;
    missing?: boolean;
    cutoffUnmet?: boolean;
    letter?: string;
}
