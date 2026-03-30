import { BaseEntity } from '../../../common/entities/base.entity';
import { Media } from './media.entity';
export declare class DownloadHistory extends BaseEntity {
    media: Media;
    mediaId: number;
    indexerId: number;
    downloadClientId: number;
    sourceTitle: string;
    quality: string;
    language: string;
    status: string;
}
