import { BaseEntity } from '../../../common/entities/base.entity';
import { Media } from './media.entity';
export declare class MediaFile extends BaseEntity {
    media: Media;
    mediaId: number;
    episodeId: number;
    relativePath: string;
    size: number;
    quality: string;
    language: string;
}
