import { RequestsService } from './requests.service';
import { CreateRequestDto } from './dto/create-request.dto';
import { ListRequestsDto } from './dto/list-requests.dto';
import { DeclineRequestDto } from './dto/decline-request.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { SuitarrRequest } from './entities/request.entity';
import { User } from '../users/entities/user.entity';
export declare class RequestsController {
    private readonly requestsService;
    constructor(requestsService: RequestsService);
    create(user: User, dto: CreateRequestDto): Promise<SuitarrRequest>;
    findAll(user: User, query: ListRequestsDto): Promise<{
        data: SuitarrRequest[];
        total: number;
    }>;
    findOne(id: number, user: User): Promise<SuitarrRequest>;
    remove(id: number, user: User): Promise<void>;
    approve(id: number, user: User): Promise<SuitarrRequest>;
    decline(id: number, user: User, dto: DeclineRequestDto): Promise<SuitarrRequest>;
    addComment(id: number, user: User, dto: CreateCommentDto): Promise<import("./entities/request-comment.entity").RequestComment>;
    getComments(id: number, user: User): Promise<import("./entities/request-comment.entity").RequestComment[]>;
    removeComment(commentId: number, user: User): Promise<void>;
}
