import { BaseEntity } from '../../../common/entities/base.entity';
export declare class BlocklistEntry extends BaseEntity {
    sourceTitle: string;
    indexerId: number;
    indexerName: string;
    downloadUrl: string;
    quality: string;
    mediaId: number;
    note: string;
}
