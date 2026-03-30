import { BaseEntity } from '../../../common/entities/base.entity';
import { Media } from './media.entity';
import { Episode } from './episode.entity';
export declare class Season extends BaseEntity {
    media: Media;
    mediaId: number;
    seasonNumber: number;
    monitored: boolean;
    episodes: Episode[];
}
