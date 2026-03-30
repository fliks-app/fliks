"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequestsService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const request_entity_1 = require("./entities/request.entity");
const request_comment_entity_1 = require("./entities/request-comment.entity");
const auto_approval_rule_entity_1 = require("./entities/auto-approval-rule.entity");
const enums_1 = require("../../common/enums");
const notifications_service_1 = require("../notifications/notifications.service");
let RequestsService = class RequestsService {
    requestRepo;
    commentRepo;
    ruleRepo;
    notifications;
    constructor(requestRepo, commentRepo, ruleRepo, notifications) {
        this.requestRepo = requestRepo;
        this.commentRepo = commentRepo;
        this.ruleRepo = ruleRepo;
        this.notifications = notifications;
    }
    evalCondition(cond, context) {
        let actual;
        switch (cond.field) {
            case 'role':
                actual = context.role;
                break;
            case 'userId':
                actual = context.userId;
                break;
            default: return true;
        }
        switch (cond.operator) {
            case 'equals': return String(actual) === String(cond.value);
            case 'notEquals': return String(actual) !== String(cond.value);
            case 'greaterThan': return Number(actual) > Number(cond.value);
            case 'lessThan': return Number(actual) < Number(cond.value);
            case 'contains': return String(actual).includes(String(cond.value));
            default: return false;
        }
    }
    async shouldAutoApprove(user, dto) {
        const rules = await this.ruleRepo.find({
            where: { enabled: true },
            order: { priority: 'DESC' },
        });
        if (!rules.length)
            return false;
        const context = {
            role: user.role,
            userId: user.id,
            mediaType: dto.mediaType,
            tmdbId: dto.tmdbId,
            title: dto.title,
        };
        return rules.some((rule) => rule.conditions.every((cond) => this.evalCondition(cond, context)));
    }
    async create(user, dto) {
        const dup = await this.requestRepo.findOne({
            where: {
                userId: user.id,
                tmdbId: dto.tmdbId,
                mediaType: dto.mediaType,
                status: enums_1.RequestStatus.PENDING,
            },
        });
        if (dup) {
            throw new common_1.ConflictException('A pending request already exists for this title');
        }
        const autoApprove = await this.shouldAutoApprove(user, dto);
        const partial = {
            userId: user.id,
            mediaType: dto.mediaType,
            tmdbId: dto.tmdbId,
            title: dto.title,
            seasons: dto.seasons ?? null,
            qualityProfileId: dto.qualityProfileId ?? null,
            rootFolder: dto.rootFolder ?? null,
            status: autoApprove ? enums_1.RequestStatus.APPROVED : enums_1.RequestStatus.PENDING,
            approvedById: autoApprove ? user.id : null,
        };
        const row = this.requestRepo.create(partial);
        const saved = await this.requestRepo.save(row);
        const event = autoApprove ? 'request.approved' : 'request.created';
        void this.notifications.dispatch(event, { title: dto.title, mediaType: dto.mediaType });
        return saved;
    }
    async findAll(user, query) {
        const page = query.page ?? 1;
        const limit = query.limit ?? 25;
        const qb = this.requestRepo
            .createQueryBuilder('r')
            .leftJoinAndSelect('r.user', 'user')
            .leftJoinAndSelect('r.approvedBy', 'approvedBy')
            .orderBy('r.createdAt', 'DESC');
        if (user.role !== enums_1.UserRole.ADMIN) {
            qb.andWhere('r.userId = :uid', { uid: user.id });
        }
        if (query.status) {
            qb.andWhere('r.status = :st', { st: query.status });
        }
        const [data, total] = await qb
            .skip((page - 1) * limit)
            .take(limit)
            .getManyAndCount();
        return { data, total };
    }
    async findOne(id, user) {
        const row = await this.requestRepo.findOne({
            where: { id },
            relations: ['user', 'approvedBy', 'comments', 'comments.user'],
        });
        if (!row)
            throw new common_1.NotFoundException(`Request #${id} not found`);
        if (user.role !== enums_1.UserRole.ADMIN && row.userId !== user.id) {
            throw new common_1.ForbiddenException();
        }
        return row;
    }
    async remove(id, user) {
        const row = await this.findOne(id, user);
        if (row.status !== enums_1.RequestStatus.PENDING) {
            throw new common_1.ForbiddenException('Only pending requests can be cancelled');
        }
        if (user.role !== enums_1.UserRole.ADMIN && row.userId !== user.id) {
            throw new common_1.ForbiddenException();
        }
        await this.requestRepo.remove(row);
    }
    async approve(id, admin) {
        if (admin.role !== enums_1.UserRole.ADMIN)
            throw new common_1.ForbiddenException();
        const row = await this.requestRepo.findOne({ where: { id } });
        if (!row)
            throw new common_1.NotFoundException(`Request #${id} not found`);
        if (row.status !== enums_1.RequestStatus.PENDING) {
            throw new common_1.ConflictException('Request is not pending');
        }
        row.status = enums_1.RequestStatus.APPROVED;
        row.approvedById = admin.id;
        row.declinedReason = null;
        const saved = await this.requestRepo.save(row);
        void this.notifications.dispatch('request.approved', { title: saved.title });
        return saved;
    }
    async decline(id, admin, reason) {
        if (admin.role !== enums_1.UserRole.ADMIN)
            throw new common_1.ForbiddenException();
        const row = await this.requestRepo.findOne({ where: { id } });
        if (!row)
            throw new common_1.NotFoundException(`Request #${id} not found`);
        if (row.status !== enums_1.RequestStatus.PENDING) {
            throw new common_1.ConflictException('Request is not pending');
        }
        row.status = enums_1.RequestStatus.DECLINED;
        row.approvedById = admin.id;
        row.declinedReason = reason ?? null;
        const saved = await this.requestRepo.save(row);
        void this.notifications.dispatch('request.declined', { title: saved.title, reason: reason ?? '' });
        return saved;
    }
    async addComment(requestId, user, dto) {
        const request = await this.requestRepo.findOne({ where: { id: requestId } });
        if (!request)
            throw new common_1.NotFoundException(`Request #${requestId} not found`);
        if (user.role !== enums_1.UserRole.ADMIN && request.userId !== user.id) {
            throw new common_1.ForbiddenException();
        }
        const comment = this.commentRepo.create({
            requestId,
            userId: user.id,
            message: dto.message,
        });
        return this.commentRepo.save(comment);
    }
    async getComments(requestId, user) {
        const request = await this.requestRepo.findOne({ where: { id: requestId } });
        if (!request)
            throw new common_1.NotFoundException(`Request #${requestId} not found`);
        if (user.role !== enums_1.UserRole.ADMIN && request.userId !== user.id) {
            throw new common_1.ForbiddenException();
        }
        return this.commentRepo.find({
            where: { requestId },
            relations: ['user'],
            order: { createdAt: 'ASC' },
        });
    }
    async removeComment(commentId, user) {
        const comment = await this.commentRepo.findOne({
            where: { id: commentId },
            relations: ['request'],
        });
        if (!comment)
            throw new common_1.NotFoundException(`Comment #${commentId} not found`);
        if (user.role !== enums_1.UserRole.ADMIN && comment.userId !== user.id) {
            throw new common_1.ForbiddenException();
        }
        await this.commentRepo.remove(comment);
    }
};
exports.RequestsService = RequestsService;
exports.RequestsService = RequestsService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(request_entity_1.SuitarrRequest)),
    __param(1, (0, typeorm_1.InjectRepository)(request_comment_entity_1.RequestComment)),
    __param(2, (0, typeorm_1.InjectRepository)(auto_approval_rule_entity_1.AutoApprovalRule)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        notifications_service_1.NotificationsService])
], RequestsService);
//# sourceMappingURL=requests.service.js.map