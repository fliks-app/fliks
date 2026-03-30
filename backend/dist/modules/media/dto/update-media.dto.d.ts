import { MediaType, MediaStatus } from '../../../common/enums';
export declare class UpdateMediaDto {
    title?: string;
    originalTitle?: string;
    year?: number;
    type?: MediaType;
    tmdbId?: number;
    imdbId?: string;
    overview?: string;
    status?: MediaStatus;
    monitored?: boolean;
    path?: string;
    posterUrl?: string;
    fanartUrl?: string;
    rating?: number;
    genres?: string[];
    runtime?: number;
    releaseDate?: string;
    qualityProfileId?: number;
    languageProfileId?: number;
    tagIds?: number[];
}
