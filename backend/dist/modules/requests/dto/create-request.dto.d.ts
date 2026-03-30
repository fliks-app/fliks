import { MediaType } from '../../../common/enums';
export declare class CreateRequestDto {
    mediaType: MediaType;
    tmdbId: number;
    title: string;
    seasons?: number[];
    qualityProfileId?: number;
    rootFolder?: string;
}
