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
exports.RequestComment = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../../common/entities/base.entity");
const user_entity_1 = require("../../users/entities/user.entity");
const request_entity_1 = require("./request.entity");
let RequestComment = class RequestComment extends base_entity_1.BaseEntity {
    request;
    requestId;
    user;
    userId;
    message;
};
exports.RequestComment = RequestComment;
__decorate([
    (0, typeorm_1.ManyToOne)(() => request_entity_1.SuitarrRequest, (request) => request.comments, {
        onDelete: 'CASCADE',
    }),
    (0, typeorm_1.JoinColumn)({ name: 'requestId' }),
    __metadata("design:type", request_entity_1.SuitarrRequest)
], RequestComment.prototype, "request", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", Number)
], RequestComment.prototype, "requestId", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => user_entity_1.User, { eager: true }),
    (0, typeorm_1.JoinColumn)({ name: 'userId' }),
    __metadata("design:type", user_entity_1.User)
], RequestComment.prototype, "user", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", Number)
], RequestComment.prototype, "userId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text' }),
    __metadata("design:type", String)
], RequestComment.prototype, "message", void 0);
exports.RequestComment = RequestComment = __decorate([
    (0, typeorm_1.Entity)('request_comments')
], RequestComment);
//# sourceMappingURL=request-comment.entity.js.map