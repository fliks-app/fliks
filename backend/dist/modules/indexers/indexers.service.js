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
exports.IndexersService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const indexer_entity_1 = require("./entities/indexer.entity");
const tag_entity_1 = require("../tags/entities/tag.entity");
const torznab_service_1 = require("./torznab.service");
let IndexersService = class IndexersService {
    indexerRepo;
    tagRepo;
    torznab;
    constructor(indexerRepo, tagRepo, torznab) {
        this.indexerRepo = indexerRepo;
        this.tagRepo = tagRepo;
        this.torznab = torznab;
    }
    async testConnection(dto) {
        const baseUrl = String(dto.settings?.baseUrl ?? '').trim();
        const apiKey = String(dto.settings?.apiKey ?? '').trim();
        return this.torznab.testConnection(baseUrl, apiKey);
    }
    sanitizeSettings(settings) {
        const out = { ...(settings ?? {}) };
        if ('minSeeders' in out) {
            out['minSeeders'] = Math.max(0, Math.floor(Number(out['minSeeders']) || 0));
        }
        return out;
    }
    async create(dto) {
        const { tagIds, ...fields } = dto;
        const row = this.indexerRepo.create({
            name: fields.name,
            implementation: fields.implementation,
            settings: this.sanitizeSettings(dto.settings),
            enableRss: fields.enableRss ?? true,
            enableSearch: fields.enableSearch ?? true,
            priority: fields.priority ?? 25,
            enabled: fields.enabled ?? true,
        });
        if (tagIds?.length) {
            row.tags = await this.tagRepo.find({ where: { id: (0, typeorm_2.In)(tagIds) } });
        }
        return this.indexerRepo.save(row);
    }
    findAll() {
        return this.indexerRepo.find({
            order: { priority: 'ASC', id: 'ASC' },
        });
    }
    async findOne(id) {
        const ix = await this.indexerRepo.findOne({ where: { id } });
        if (!ix)
            throw new common_1.NotFoundException(`Indexer #${id} not found`);
        return ix;
    }
    async update(id, dto) {
        const ix = await this.findOne(id);
        const { tagIds, ...patch } = dto;
        if (patch.name !== undefined)
            ix.name = patch.name;
        if (patch.implementation !== undefined)
            ix.implementation = patch.implementation;
        if (patch.enableRss !== undefined)
            ix.enableRss = patch.enableRss;
        if (patch.enableSearch !== undefined)
            ix.enableSearch = patch.enableSearch;
        if (patch.priority !== undefined)
            ix.priority = patch.priority;
        if (patch.enabled !== undefined)
            ix.enabled = patch.enabled;
        if (patch.settings !== undefined)
            ix.settings = this.sanitizeSettings(patch.settings);
        if (tagIds !== undefined) {
            ix.tags = tagIds.length
                ? await this.tagRepo.find({ where: { id: (0, typeorm_2.In)(tagIds) } })
                : [];
        }
        return this.indexerRepo.save(ix);
    }
    async remove(id) {
        const ix = await this.findOne(id);
        await this.indexerRepo.remove(ix);
    }
};
exports.IndexersService = IndexersService;
exports.IndexersService = IndexersService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(indexer_entity_1.Indexer)),
    __param(1, (0, typeorm_1.InjectRepository)(tag_entity_1.Tag)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        torznab_service_1.TorznabService])
], IndexersService);
//# sourceMappingURL=indexers.service.js.map