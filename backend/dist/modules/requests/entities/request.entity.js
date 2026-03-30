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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SuitarrRequest = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../../common/entities/base.entity");
const enums_1 = require("../../../common/enums");
const user_entity_1 = require("../../users/entities/user.entity");
const request_comment_entity_1 = require("./request-comment.entity");
let SuitarrRequest = class SuitarrRequest extends base_entity_1.BaseEntity {
    user;
    userId;
    mediaType;
    tmdbId;
    title;
    status;
    approvedBy;
    approvedById;
    declinedReason;
    qualityProfileId;
    rootFolder;
    seasons;
    comments;
};
exports.SuitarrRequest = SuitarrRequest;
__decorate([
    (0, typeorm_1.ManyToOne)(() => user_entity_1.User, { eager: true }),
    (0, typeorm_1.JoinColumn)({ name: 'userId' }),
    __metadata("design:type", user_entity_1.User)
], SuitarrRequest.prototype, "user", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", Number)
], SuitarrRequest.prototype, "userId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'enum', enum: enums_1.MediaType }),
    __metadata("design:type", String)
], SuitarrRequest.prototype, "mediaType", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", Number)
], SuitarrRequest.prototype, "tmdbId", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], SuitarrRequest.prototype, "title", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: enums_1.RequestStatus,
        default: enums_1.RequestStatus.PENDING,
    }),
    __metadata("design:type", String)
], SuitarrRequest.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => user_entity_1.User, { nullable: true }),
    (0, typeorm_1.JoinColumn)({ name: 'approvedById' }),
    __metadata("design:type", user_entity_1.User)
], SuitarrRequest.prototype, "approvedBy", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', nullable: true }),
    __metadata("design:type", Object)
], SuitarrRequest.prototype, "approvedById", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], SuitarrRequest.prototype, "declinedReason", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', nullable: true }),
    __metadata("design:type", Object)
], SuitarrRequest.prototype, "qualityProfileId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], SuitarrRequest.prototype, "rootFolder", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'jsonb', nullable: true }),
    __metadata("design:type", Object)
], SuitarrRequest.prototype, "seasons", void 0);
__decorate([
    (0, typeorm_1.OneToMany)(() => request_comment_entity_1.RequestComment, (comment) => comment.request, {
        cascade: true,
    }),
    __metadata("design:type", Array)
], SuitarrRequest.prototype, "comments", void 0);
exports.SuitarrRequest = SuitarrRequest = __decorate([
    (0, typeorm_1.Entity)('requests')
], SuitarrRequest);
//# sourceMappingURL=request.entity.js.map