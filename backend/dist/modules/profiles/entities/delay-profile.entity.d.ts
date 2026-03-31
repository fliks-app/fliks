import { BaseEntity } from '../../../common/entities/base.entity';
import { Tag } from '../../tags/entities/tag.entity';
export declare class DelayProfile extends BaseEntity {
    torrentDelay: number;
    order: number;
    tags: Tag[];
}
