import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import { SuitarrRequest } from './request.entity';
export declare class RequestComment extends BaseEntity {
    request: SuitarrRequest;
    requestId: number;
    user: User;
    userId: number;
    message: string;
}
