import { BaseEntity } from '../../../common/entities/base.entity';
import { MediaType, RequestStatus } from '../../../common/enums';
import { User } from '../../users/entities/user.entity';
import { RequestComment } from './request-comment.entity';
export declare class SuitarrRequest extends BaseEntity {
    user: User;
    userId: number;
    mediaType: MediaType;
    tmdbId: number;
    title: string;
    status: RequestStatus;
    approvedBy: User;
    approvedById: number | null;
    declinedReason: string | null;
    qualityProfileId: number | null;
    rootFolder: string | null;
    seasons: number[] | null;
    comments: RequestComment[];
}
