import { MediaType } from '../../../common/enums';
export declare class ImportTmdbDto {
    type: MediaType;
    tmdbId: number;
    qualityProfileId?: number;
    rootFolderId?: number;
}
