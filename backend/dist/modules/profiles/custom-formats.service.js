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
exports.CustomFormatsService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const custom_format_entity_1 = require("./entities/custom-format.entity");
let CustomFormatsService = class CustomFormatsService {
    repo;
    constructor(repo) {
        this.repo = repo;
    }
    create(dto) {
        const row = this.repo.create({
            name: dto.name,
            score: dto.score ?? 0,
            specifications: (dto.specifications ?? []),
        });
        return this.repo.save(row);
    }
    findAll() {
        return this.repo.find({ order: { name: 'ASC' } });
    }
    async findOne(id) {
        const cf = await this.repo.findOne({ where: { id } });
        if (!cf)
            throw new common_1.NotFoundException(`Custom format #${id} not found`);
        return cf;
    }
    async update(id, dto) {
        const cf = await this.findOne(id);
        if (dto.name !== undefined)
            cf.name = dto.name;
        if (dto.score !== undefined)
            cf.score = dto.score;
        if (dto.specifications !== undefined)
            cf.specifications = dto.specifications;
        return this.repo.save(cf);
    }
    async remove(id) {
        const cf = await this.findOne(id);
        await this.repo.remove(cf);
    }
    async testRelease(title, meta) {
        const formats = await this.repo.find();
        return formats.map(cf => ({
            formatId: cf.id,
            formatName: cf.name,
            matched: this.matchesFormat(title, cf, meta),
            score: this.matchesFormat(title, cf, meta) ? cf.score : 0,
        }));
    }
    async scoreRelease(releaseTitle, meta) {
        const formats = await this.findAll();
        let total = 0;
        for (const fmt of formats) {
            if (this.matchesFormat(releaseTitle, fmt, meta)) {
                total += fmt.score;
            }
        }
        return total;
    }
    matchesFormat(title, fmt, meta) {
        const titleLower = title.toLowerCase();
        let allRequiredMet = true;
        let anyNonRequiredMet = false;
        let hasNonRequired = false;
        for (const spec of fmt.specifications) {
            const match = this.evalSpec(titleLower, spec, meta);
            const result = spec.negate ? !match : match;
            if (spec.required) {
                if (!result)
                    allRequiredMet = false;
            }
            else {
                hasNonRequired = true;
                if (result)
                    anyNonRequiredMet = true;
            }
        }
        if (!allRequiredMet)
            return false;
        if (hasNonRequired && !anyNonRequiredMet)
            return false;
        return true;
    }
    evalSpec(titleLower, spec, meta) {
        const val = (spec.value || '').toLowerCase();
        switch (spec.implementation) {
            case 'title_regex':
                try {
                    return new RegExp(spec.value, 'i').test(titleLower);
                }
                catch {
                    return false;
                }
            case 'source':
                return titleLower.includes(val);
            case 'resolution':
                return titleLower.includes(val);
            case 'language':
                return titleLower.includes(val);
            case 'indexer_flag':
                if (val === 'freeleech')
                    return meta?.freeleech === true;
                if (val === 'halfleech')
                    return meta?.downloadVolumeFactor === 0.5;
                return false;
            default:
                return false;
        }
    }
};
exports.CustomFormatsService = CustomFormatsService;
exports.CustomFormatsService = CustomFormatsService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(custom_format_entity_1.CustomFormat)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], CustomFormatsService);
//# sourceMappingURL=custom-formats.service.js.map