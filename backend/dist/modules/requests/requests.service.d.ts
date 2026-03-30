import { Repository } from 'typeorm';
import { SuitarrRequest } from './entities/request.entity';
import { RequestComment } from './entities/request-comment.entity';
import { AutoApprovalRule } from './entities/auto-approval-rule.entity';
import { User } from '../users/entities/user.entity';
import { CreateRequestDto } from './dto/create-request.dto';
import { ListRequestsDto } from './dto/list-requests.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { NotificationsService } from '../notifications/notifications.service';
export declare class RequestsService {
    private readonly requestRepo;
    private readonly commentRepo;
    private readonly ruleRepo;
    private readonly notifications;
    constructor(requestRepo: Repository<SuitarrRequest>, commentRepo: Repository<RequestComment>, ruleRepo: Repository<AutoApprovalRule>, notifications: NotificationsService);
    private evalCondition;
    private shouldAutoApprove;
    create(user: User, dto: CreateRequestDto): Promise<SuitarrRequest>;
    findAll(user: User, query: ListRequestsDto): Promise<{
        data: SuitarrRequest[];
        total: number;
    }>;
    findOne(id: number, user: User): Promise<SuitarrRequest>;
    remove(id: number, user: User): Promise<void>;
    approve(id: number, admin: User): Promise<SuitarrRequest>;
    decline(id: number, admin: User, reason?: string): Promise<SuitarrRequest>;
    addComment(requestId: number, user: User, dto: CreateCommentDto): Promise<RequestComment>;
    getComments(requestId: number, user: User): Promise<RequestComment[]>;
    removeComment(commentId: number, user: User): Promise<void>;
}
