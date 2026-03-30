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
exports.AutoApprovalRulesController = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const auto_approval_rule_entity_1 = require("./entities/auto-approval-rule.entity");
const create_auto_approval_rule_dto_1 = require("./dto/create-auto-approval-rule.dto");
const jwt_or_api_key_guard_1 = require("../auth/guards/jwt-or-api-key.guard");
const policies_guard_1 = require("../auth/casl/policies.guard");
const check_policies_decorator_1 = require("../auth/casl/check-policies.decorator");
const actions_enum_1 = require("../auth/casl/actions.enum");
const common_2 = require("@nestjs/common");
let AutoApprovalRulesController = class AutoApprovalRulesController {
    repo;
    constructor(repo) {
        this.repo = repo;
    }
    create(dto) {
        const row = this.repo.create({
            name: dto.name,
            enabled: dto.enabled ?? true,
            conditions: dto.conditions,
            priority: dto.priority ?? 0,
        });
        return this.repo.save(row);
    }
    findAll() {
        return this.repo.find({ order: { priority: 'DESC', id: 'ASC' } });
    }
    async findOne(id) {
        const rule = await this.repo.findOne({ where: { id } });
        if (!rule)
            throw new common_2.NotFoundException(`Rule #${id} not found`);
        return rule;
    }
    async update(id, dto) {
        const rule = await this.repo.findOne({ where: { id } });
        if (!rule)
            throw new common_2.NotFoundException(`Rule #${id} not found`);
        if (dto.name !== undefined)
            rule.name = dto.name;
        if (dto.enabled !== undefined)
            rule.enabled = dto.enabled;
        if (dto.conditions !== undefined)
            rule.conditions = dto.conditions;
        if (dto.priority !== undefined)
            rule.priority = dto.priority;
        return this.repo.save(rule);
    }
    async remove(id) {
        const rule = await this.repo.findOne({ where: { id } });
        if (!rule)
            throw new common_2.NotFoundException(`Rule #${id} not found`);
        await this.repo.remove(rule);
    }
};
exports.AutoApprovalRulesController = AutoApprovalRulesController;
__decorate([
    (0, common_1.Post)(),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Manage, 'Settings')),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [create_auto_approval_rule_dto_1.CreateAutoApprovalRuleDto]),
    __metadata("design:returntype", void 0)
], AutoApprovalRulesController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, 'Settings')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], AutoApprovalRulesController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, 'Settings')),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", Promise)
], AutoApprovalRulesController.prototype, "findOne", null);
__decorate([
    (0, common_1.Put)(':id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Manage, 'Settings')),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, create_auto_approval_rule_dto_1.CreateAutoApprovalRuleDto]),
    __metadata("design:returntype", Promise)
], AutoApprovalRulesController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Manage, 'Settings')),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", Promise)
], AutoApprovalRulesController.prototype, "remove", null);
exports.AutoApprovalRulesController = AutoApprovalRulesController = __decorate([
    (0, common_1.Controller)('auto-approval-rules'),
    (0, common_1.UseGuards)(jwt_or_api_key_guard_1.JwtOrApiKeyGuard, policies_guard_1.PoliciesGuard),
    __param(0, (0, typeorm_1.InjectRepository)(auto_approval_rule_entity_1.AutoApprovalRule)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], AutoApprovalRulesController);
//# sourceMappingURL=auto-approval-rules.controller.js.map