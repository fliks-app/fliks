"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequestsModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const request_entity_1 = require("./entities/request.entity");
const request_comment_entity_1 = require("./entities/request-comment.entity");
const auto_approval_rule_entity_1 = require("./entities/auto-approval-rule.entity");
const auth_module_1 = require("../auth/auth.module");
const notifications_module_1 = require("../notifications/notifications.module");
const requests_service_1 = require("./requests.service");
const requests_controller_1 = require("./requests.controller");
const auto_approval_rules_controller_1 = require("./auto-approval-rules.controller");
let RequestsModule = class RequestsModule {
};
exports.RequestsModule = RequestsModule;
exports.RequestsModule = RequestsModule = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([request_entity_1.SuitarrRequest, request_comment_entity_1.RequestComment, auto_approval_rule_entity_1.AutoApprovalRule]),
            auth_module_1.AuthModule,
            notifications_module_1.NotificationsModule,
        ],
        controllers: [requests_controller_1.RequestsController, auto_approval_rules_controller_1.AutoApprovalRulesController],
        providers: [requests_service_1.RequestsService],
        exports: [requests_service_1.RequestsService],
    })
], RequestsModule);
//# sourceMappingURL=requests.module.js.map