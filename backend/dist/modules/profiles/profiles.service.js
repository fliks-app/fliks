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
exports.ProfilesService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const quality_profile_entity_1 = require("./entities/quality-profile.entity");
const language_profile_entity_1 = require("./entities/language-profile.entity");
const default_movie_quality_profile_1 = require("./default-movie-quality-profile");
let ProfilesService = class ProfilesService {
    qpRepo;
    lpRepo;
    constructor(qpRepo, lpRepo) {
        this.qpRepo = qpRepo;
        this.lpRepo = lpRepo;
    }
    async ensureDefaultQualityProfiles() {
        if ((await this.qpRepo.count()) > 0)
            return;
        await this.createQualityProfile((0, default_movie_quality_profile_1.buildDefaultMovieQualityProfileDto)());
    }
    async resolveQualityProfileIdForImport(requested) {
        await this.ensureDefaultQualityProfiles();
        if (requested != null) {
            const p = await this.qpRepo.findOne({ where: { id: requested } });
            if (!p) {
                throw new common_1.BadRequestException(`Quality profile #${requested} not found`);
            }
            return p.id;
        }
        const first = await this.qpRepo.findOne({ order: { id: 'ASC' } });
        return first?.id ?? null;
    }
    async createQualityProfile(dto) {
        const profile = this.qpRepo.create({
            name: dto.name,
            cutoff: dto.cutoff,
            upgradeAllowed: dto.upgradeAllowed ?? false,
            items: dto.items.map((i) => ({
                quality: {
                    id: i.qualityId,
                    name: i.qualityName,
                    resolution: i.resolution,
                    source: i.source,
                },
                allowed: i.allowed,
                sortOrder: i.sortOrder,
            })),
        });
        return this.qpRepo.save(profile);
    }
    findAllQualityProfiles() {
        return this.qpRepo.find({ order: { name: 'ASC' } });
    }
    async findOneQualityProfile(id) {
        const profile = await this.qpRepo.findOne({ where: { id } });
        if (!profile)
            throw new common_1.NotFoundException(`QualityProfile #${id} not found`);
        return profile;
    }
    async updateQualityProfile(id, dto) {
        const profile = await this.findOneQualityProfile(id);
        profile.name = dto.name;
        profile.cutoff = dto.cutoff;
        profile.upgradeAllowed = dto.upgradeAllowed ?? profile.upgradeAllowed;
        profile.items = dto.items.map((i) => ({
            quality: {
                id: i.qualityId,
                name: i.qualityName,
                resolution: i.resolution,
                source: i.source,
            },
            allowed: i.allowed,
            sortOrder: i.sortOrder,
        }));
        return this.qpRepo.save(profile);
    }
    async removeQualityProfile(id) {
        const profile = await this.findOneQualityProfile(id);
        await this.qpRepo.remove(profile);
    }
    async createLanguageProfile(dto) {
        const profile = this.lpRepo.create({
            name: dto.name,
            cutoff: dto.cutoff,
            languages: dto.languages.map((l) => ({
                language: {
                    id: l.languageId,
                    name: l.languageName,
                    isoCode: l.isoCode,
                },
                allowed: l.allowed,
                sortOrder: l.sortOrder,
            })),
        });
        return this.lpRepo.save(profile);
    }
    findAllLanguageProfiles() {
        return this.lpRepo.find({ order: { name: 'ASC' } });
    }
    async findOneLanguageProfile(id) {
        const profile = await this.lpRepo.findOne({ where: { id } });
        if (!profile)
            throw new common_1.NotFoundException(`LanguageProfile #${id} not found`);
        return profile;
    }
    async updateLanguageProfile(id, dto) {
        const profile = await this.findOneLanguageProfile(id);
        profile.name = dto.name;
        profile.cutoff = dto.cutoff;
        profile.languages = dto.languages.map((l) => ({
            language: {
                id: l.languageId,
                name: l.languageName,
                isoCode: l.isoCode,
            },
            allowed: l.allowed,
            sortOrder: l.sortOrder,
        }));
        return this.lpRepo.save(profile);
    }
    async removeLanguageProfile(id) {
        const profile = await this.findOneLanguageProfile(id);
        await this.lpRepo.remove(profile);
    }
};
exports.ProfilesService = ProfilesService;
exports.ProfilesService = ProfilesService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(quality_profile_entity_1.QualityProfile)),
    __param(1, (0, typeorm_1.InjectRepository)(language_profile_entity_1.LanguageProfile)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository])
], ProfilesService);
//# sourceMappingURL=profiles.service.js.map