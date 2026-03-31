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
exports.IndexersController = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const indexers_service_1 = require("./indexers.service");
const create_indexer_dto_1 = require("./dto/create-indexer.dto");
const update_indexer_dto_1 = require("./dto/update-indexer.dto");
const test_indexer_connection_dto_1 = require("./dto/test-indexer-connection.dto");
const jwt_or_api_key_guard_1 = require("../auth/guards/jwt-or-api-key.guard");
const policies_guard_1 = require("../auth/casl/policies.guard");
const check_policies_decorator_1 = require("../auth/casl/check-policies.decorator");
const actions_enum_1 = require("../auth/casl/actions.enum");
const indexer_entity_1 = require("./entities/indexer.entity");
const indexer_stat_entity_1 = require("./entities/indexer-stat.entity");
let IndexersController = class IndexersController {
    indexersService;
    statRepo;
    constructor(indexersService, statRepo) {
        this.indexersService = indexersService;
        this.statRepo = statRepo;
    }
    testConnection(dto) {
        return this.indexersService.testConnection(dto);
    }
    create(dto) {
        return this.indexersService.create(dto);
    }
    findAll() {
        return this.indexersService.findAll();
    }
    findOne(id) {
        return this.indexersService.findOne(id);
    }
    update(id, dto) {
        return this.indexersService.update(id, dto);
    }
    remove(id) {
        return this.indexersService.remove(id);
    }
    async getStats(id) {
        const since = new Date();
        since.setDate(since.getDate() - 30);
        const rows = await this.statRepo
            .createQueryBuilder('s')
            .select("DATE(s.queryDate)", 'date')
            .addSelect("COUNT(*)", 'queries')
            .addSelect("AVG(s.responseTimeMs)::int", 'avgResponseMs')
            .addSelect("SUM(s.resultCount)::int", 'totalResults')
            .addSelect("SUM(CASE WHEN s.errorMessage IS NOT NULL THEN 1 ELSE 0 END)::int", 'errors')
            .where('s.indexerId = :id', { id })
            .andWhere('s.queryDate >= :since', { since })
            .groupBy("DATE(s.queryDate)")
            .orderBy("date", 'DESC')
            .getRawMany();
        return rows;
    }
};
exports.IndexersController = IndexersController;
__decorate([
    (0, common_1.Post)('test-connection'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, indexer_entity_1.Indexer)),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [test_indexer_connection_dto_1.TestIndexerConnectionDto]),
    __metadata("design:returntype", void 0)
], IndexersController.prototype, "testConnection", null);
__decorate([
    (0, common_1.Post)(),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Create, indexer_entity_1.Indexer)),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [create_indexer_dto_1.CreateIndexerDto]),
    __metadata("design:returntype", void 0)
], IndexersController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, indexer_entity_1.Indexer)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], IndexersController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, indexer_entity_1.Indexer)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], IndexersController.prototype, "findOne", null);
__decorate([
    (0, common_1.Put)(':id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Update, indexer_entity_1.Indexer)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, update_indexer_dto_1.UpdateIndexerDto]),
    __metadata("design:returntype", void 0)
], IndexersController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Delete, indexer_entity_1.Indexer)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], IndexersController.prototype, "remove", null);
__decorate([
    (0, common_1.Get)(':id/stats'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, indexer_entity_1.Indexer)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", Promise)
], IndexersController.prototype, "getStats", null);
exports.IndexersController = IndexersController = __decorate([
    (0, common_1.Controller)('indexers'),
    (0, common_1.UseGuards)(jwt_or_api_key_guard_1.JwtOrApiKeyGuard, policies_guard_1.PoliciesGuard),
    __param(1, (0, typeorm_1.InjectRepository)(indexer_stat_entity_1.IndexerStat)),
    __metadata("design:paramtypes", [indexers_service_1.IndexersService,
        typeorm_2.Repository])
], IndexersController);
//# sourceMappingURL=indexers.controller.js.map