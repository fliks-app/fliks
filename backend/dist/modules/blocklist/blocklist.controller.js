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
exports.BlocklistController = void 0;
const common_1 = require("@nestjs/common");
const blocklist_service_1 = require("./blocklist.service");
const create_blocklist_entry_dto_1 = require("./dto/create-blocklist-entry.dto");
const jwt_or_api_key_guard_1 = require("../auth/guards/jwt-or-api-key.guard");
const policies_guard_1 = require("../auth/casl/policies.guard");
const check_policies_decorator_1 = require("../auth/casl/check-policies.decorator");
const actions_enum_1 = require("../auth/casl/actions.enum");
let BlocklistController = class BlocklistController {
    service;
    constructor(service) {
        this.service = service;
    }
    create(dto) {
        return this.service.create(dto);
    }
    findAll(page, limit) {
        return this.service.findAll(page ? Number(page) : 1, limit ? Number(limit) : 25);
    }
    clear() {
        return this.service.clear();
    }
    remove(id) {
        return this.service.remove(id);
    }
};
exports.BlocklistController = BlocklistController;
__decorate([
    (0, common_1.Post)(),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Manage, 'Settings')),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [create_blocklist_entry_dto_1.CreateBlocklistEntryDto]),
    __metadata("design:returntype", void 0)
], BlocklistController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, 'Settings')),
    __param(0, (0, common_1.Query)('page')),
    __param(1, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], BlocklistController.prototype, "findAll", null);
__decorate([
    (0, common_1.Delete)('all'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Manage, 'Settings')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], BlocklistController.prototype, "clear", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Manage, 'Settings')),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], BlocklistController.prototype, "remove", null);
exports.BlocklistController = BlocklistController = __decorate([
    (0, common_1.Controller)('blocklist'),
    (0, common_1.UseGuards)(jwt_or_api_key_guard_1.JwtOrApiKeyGuard, policies_guard_1.PoliciesGuard),
    __metadata("design:paramtypes", [blocklist_service_1.BlocklistService])
], BlocklistController);
//# sourceMappingURL=blocklist.controller.js.map