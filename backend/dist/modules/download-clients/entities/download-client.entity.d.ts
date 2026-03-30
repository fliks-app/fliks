import { BaseEntity } from '../../../common/entities/base.entity';
import { Tag } from '../../tags/entities/tag.entity';
export declare class DownloadClient extends BaseEntity {
    name: string;
    implementation: string;
    settings: Record<string, unknown>;
    enabled: boolean;
    priority: number;
    tags: Tag[];
}
