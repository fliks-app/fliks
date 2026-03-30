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
exports.RequestsController = void 0;
const common_1 = require("@nestjs/common");
const requests_service_1 = require("./requests.service");
const create_request_dto_1 = require("./dto/create-request.dto");
const list_requests_dto_1 = require("./dto/list-requests.dto");
const decline_request_dto_1 = require("./dto/decline-request.dto");
const create_comment_dto_1 = require("./dto/create-comment.dto");
const jwt_or_api_key_guard_1 = require("../auth/guards/jwt-or-api-key.guard");
const policies_guard_1 = require("../auth/casl/policies.guard");
const check_policies_decorator_1 = require("../auth/casl/check-policies.decorator");
const actions_enum_1 = require("../auth/casl/actions.enum");
const request_entity_1 = require("./entities/request.entity");
const current_user_decorator_1 = require("../auth/decorators/current-user.decorator");
const user_entity_1 = require("../users/entities/user.entity");
let RequestsController = class RequestsController {
    requestsService;
    constructor(requestsService) {
        this.requestsService = requestsService;
    }
    create(user, dto) {
        return this.requestsService.create(user, dto);
    }
    findAll(user, query) {
        return this.requestsService.findAll(user, query);
    }
    findOne(id, user) {
        return this.requestsService.findOne(id, user);
    }
    remove(id, user) {
        return this.requestsService.remove(id, user);
    }
    approve(id, user) {
        return this.requestsService.approve(id, user);
    }
    decline(id, user, dto) {
        return this.requestsService.decline(id, user, dto.reason);
    }
    addComment(id, user, dto) {
        return this.requestsService.addComment(id, user, dto);
    }
    getComments(id, user) {
        return this.requestsService.getComments(id, user);
    }
    removeComment(commentId, user) {
        return this.requestsService.removeComment(commentId, user);
    }
};
exports.RequestsController = RequestsController;
__decorate([
    (0, common_1.Post)(),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Create, request_entity_1.SuitarrRequest)),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User, create_request_dto_1.CreateRequestDto]),
    __metadata("design:returntype", void 0)
], RequestsController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, request_entity_1.SuitarrRequest)),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User, list_requests_dto_1.ListRequestsDto]),
    __metadata("design:returntype", void 0)
], RequestsController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, request_entity_1.SuitarrRequest)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, user_entity_1.User]),
    __metadata("design:returntype", void 0)
], RequestsController.prototype, "findOne", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Delete, request_entity_1.SuitarrRequest)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, user_entity_1.User]),
    __metadata("design:returntype", void 0)
], RequestsController.prototype, "remove", null);
__decorate([
    (0, common_1.Post)(':id/approve'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Approve, request_entity_1.SuitarrRequest)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, user_entity_1.User]),
    __metadata("design:returntype", void 0)
], RequestsController.prototype, "approve", null);
__decorate([
    (0, common_1.Post)(':id/decline'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Decline, request_entity_1.SuitarrRequest)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, current_user_decorator_1.CurrentUser)()),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, user_entity_1.User,
        decline_request_dto_1.DeclineRequestDto]),
    __metadata("design:returntype", void 0)
], RequestsController.prototype, "decline", null);
__decorate([
    (0, common_1.Post)(':id/comments'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, request_entity_1.SuitarrRequest)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, current_user_decorator_1.CurrentUser)()),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, user_entity_1.User,
        create_comment_dto_1.CreateCommentDto]),
    __metadata("design:returntype", void 0)
], RequestsController.prototype, "addComment", null);
__decorate([
    (0, common_1.Get)(':id/comments'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, request_entity_1.SuitarrRequest)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, user_entity_1.User]),
    __metadata("design:returntype", void 0)
], RequestsController.prototype, "getComments", null);
__decorate([
    (0, common_1.Delete)('comments/:commentId'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, request_entity_1.SuitarrRequest)),
    __param(0, (0, common_1.Param)('commentId', common_1.ParseIntPipe)),
    __param(1, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, user_entity_1.User]),
    __metadata("design:returntype", void 0)
], RequestsController.prototype, "removeComment", null);
exports.RequestsController = RequestsController = __decorate([
    (0, common_1.Controller)('requests'),
    (0, common_1.UseGuards)(jwt_or_api_key_guard_1.JwtOrApiKeyGuard, policies_guard_1.PoliciesGuard),
    __metadata("design:paramtypes", [requests_service_1.RequestsService])
], RequestsController);
//# sourceMappingURL=requests.controller.js.map