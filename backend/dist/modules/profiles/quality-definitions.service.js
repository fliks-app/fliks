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
var QualityDefinitionsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.QualityDefinitionsService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const quality_definition_entity_1 = require("./entities/quality-definition.entity");
const suitarr_qualities_1 = require("../../common/constants/suitarr-qualities");
const DEFAULTS = {
    0: { min: 0, preferred: 95, max: 100 },
    480: { min: 0, preferred: 95, max: 100 },
    720: { min: 0, preferred: 137.3, max: 162.2 },
    1080: { min: 0, preferred: 137.3, max: 227.9 },
    2160: { min: 0, preferred: 302.5, max: 400 },
};
let QualityDefinitionsService = QualityDefinitionsService_1 = class QualityDefinitionsService {
    repo;
    log = new common_1.Logger(QualityDefinitionsService_1.name);
    constructor(repo) {
        this.repo = repo;
    }
    async ensureDefaults() {
        if ((await this.repo.count()) > 0)
            return;
        const entities = suitarr_qualities_1.SUITARR_QUALITIES.map((q) => {
            const def = DEFAULTS[q.resolution] ?? DEFAULTS[0];
            return this.repo.create({
                qualityId: q.id,
                title: q.name,
                minSize: def.min,
                preferredSize: def.preferred,
                maxSize: def.max,
            });
        });
        await this.repo.save(entities);
        this.log.log(`Seeded ${entities.length} quality definitions`);
    }
    async findAll() {
        await this.ensureDefaults();
        return this.repo.find({ order: { qualityId: 'ASC' } });
    }
    async updateAll(items) {
        await this.ensureDefaults();
        for (const item of items) {
            await this.repo.update({ qualityId: item.qualityId }, {
                title: item.title,
                minSize: item.minSize,
                preferredSize: item.preferredSize,
                maxSize: item.maxSize,
            });
        }
        return this.findAll();
    }
    async getSizeLimitsMap() {
        const defs = await this.findAll();
        return new Map(defs.map((d) => [
            d.qualityId,
            { min: d.minSize, preferred: d.preferredSize, max: d.maxSize },
        ]));
    }
};
exports.QualityDefinitionsService = QualityDefinitionsService;
exports.QualityDefinitionsService = QualityDefinitionsService = QualityDefinitionsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(quality_definition_entity_1.QualityDefinition)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], QualityDefinitionsService);
//# sourceMappingURL=quality-definitions.service.js.map