import { BaseEntity } from '../../../common/entities/base.entity';
import { Tag } from '../../tags/entities/tag.entity';
export declare class Indexer extends BaseEntity {
    name: string;
    implementation: string;
    settings: Record<string, unknown>;
    enableRss: boolean;
    enableSearch: boolean;
    priority: number;
    enabled: boolean;
    tags: Tag[];
}
