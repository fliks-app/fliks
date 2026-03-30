import { BaseEntity } from '../../../common/entities/base.entity';
import { Season } from './season.entity';
export declare class Episode extends BaseEntity {
    season: Season;
    seasonId: number;
    episodeNumber: number;
    title: string;
    overview: string;
    airDate: string;
    monitored: boolean;
    hasFile: boolean;
    searchVector: string;
}
