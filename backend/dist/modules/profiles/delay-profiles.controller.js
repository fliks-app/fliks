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
exports.DelayProfilesController = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const delay_profile_entity_1 = require("./entities/delay-profile.entity");
const create_delay_profile_dto_1 = require("./dto/create-delay-profile.dto");
const tag_entity_1 = require("../tags/entities/tag.entity");
const jwt_or_api_key_guard_1 = require("../auth/guards/jwt-or-api-key.guard");
const policies_guard_1 = require("../auth/casl/policies.guard");
const check_policies_decorator_1 = require("../auth/casl/check-policies.decorator");
const actions_enum_1 = require("../auth/casl/actions.enum");
let DelayProfilesController = class DelayProfilesController {
    repo;
    tagRepo;
    constructor(repo, tagRepo) {
        this.repo = repo;
        this.tagRepo = tagRepo;
    }
    findAll() {
        return this.repo.find({ order: { order: 'ASC', id: 'ASC' } });
    }
    async create(dto) {
        const row = this.repo.create({
            torrentDelay: dto.torrentDelay,
            order: dto.order ?? 1,
        });
        if (dto.tagIds?.length) {
            row.tags = await this.tagRepo.find({ where: { id: (0, typeorm_2.In)(dto.tagIds) } });
        }
        return this.repo.save(row);
    }
    async update(id, dto) {
        const row = await this.repo.findOne({ where: { id } });
        if (!row)
            throw new common_1.NotFoundException(`DelayProfile #${id} not found`);
        row.torrentDelay = dto.torrentDelay;
        row.order = dto.order ?? row.order;
        if (dto.tagIds !== undefined) {
            row.tags = dto.tagIds.length
                ? await this.tagRepo.find({ where: { id: (0, typeorm_2.In)(dto.tagIds) } })
                : [];
        }
        return this.repo.save(row);
    }
    async remove(id) {
        const row = await this.repo.findOne({ where: { id } });
        if (!row)
            throw new common_1.NotFoundException(`DelayProfile #${id} not found`);
        await this.repo.remove(row);
    }
};
exports.DelayProfilesController = DelayProfilesController;
__decorate([
    (0, common_1.Get)(),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, 'Settings')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], DelayProfilesController.prototype, "findAll", null);
__decorate([
    (0, common_1.Post)(),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Create, 'Settings')),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [create_delay_profile_dto_1.CreateDelayProfileDto]),
    __metadata("design:returntype", Promise)
], DelayProfilesController.prototype, "create", null);
__decorate([
    (0, common_1.Put)(':id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Update, 'Settings')),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, create_delay_profile_dto_1.CreateDelayProfileDto]),
    __metadata("design:returntype", Promise)
], DelayProfilesController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Delete, 'Settings')),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", Promise)
], DelayProfilesController.prototype, "remove", null);
exports.DelayProfilesController = DelayProfilesController = __decorate([
    (0, common_1.Controller)('profiles/delay'),
    (0, common_1.UseGuards)(jwt_or_api_key_guard_1.JwtOrApiKeyGuard, policies_guard_1.PoliciesGuard),
    __param(0, (0, typeorm_1.InjectRepository)(delay_profile_entity_1.DelayProfile)),
    __param(1, (0, typeorm_1.InjectRepository)(tag_entity_1.Tag)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository])
], DelayProfilesController);
//# sourceMappingURL=delay-profiles.controller.js.map