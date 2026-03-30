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
exports.TagsService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const tag_entity_1 = require("./entities/tag.entity");
let TagsService = class TagsService {
    tagRepo;
    constructor(tagRepo) {
        this.tagRepo = tagRepo;
    }
    async create(dto) {
        const existing = await this.tagRepo.findOne({
            where: { label: dto.label },
        });
        if (existing) {
            throw new common_1.ConflictException(`Tag "${dto.label}" already exists`);
        }
        return this.tagRepo.save(this.tagRepo.create(dto));
    }
    findAll() {
        return this.tagRepo.find({ order: { label: 'ASC' } });
    }
    async findOne(id) {
        const tag = await this.tagRepo.findOne({ where: { id } });
        if (!tag) {
            throw new common_1.NotFoundException(`Tag #${id} not found`);
        }
        return tag;
    }
    async update(id, dto) {
        const tag = await this.findOne(id);
        tag.label = dto.label;
        return this.tagRepo.save(tag);
    }
    async remove(id) {
        const tag = await this.findOne(id);
        await this.tagRepo.remove(tag);
    }
};
exports.TagsService = TagsService;
exports.TagsService = TagsService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(tag_entity_1.Tag)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], TagsService);
//# sourceMappingURL=tags.service.js.map