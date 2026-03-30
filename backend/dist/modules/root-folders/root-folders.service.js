"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RootFoldersService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const fs = __importStar(require("fs"));
const root_folder_entity_1 = require("./entities/root-folder.entity");
let RootFoldersService = class RootFoldersService {
    repo;
    constructor(repo) {
        this.repo = repo;
    }
    diskInfo(path) {
        try {
            const stats = fs.statfsSync(path);
            return {
                freeSpace: stats.bfree * stats.bsize,
                totalSpace: stats.blocks * stats.bsize,
            };
        }
        catch {
            return { freeSpace: -1, totalSpace: -1 };
        }
    }
    enrich(folder) {
        const disk = this.diskInfo(folder.path);
        return { ...folder, ...disk, accessible: disk.freeSpace !== -1 };
    }
    async create(dto) {
        if (!fs.existsSync(dto.path)) {
            throw new common_1.BadRequestException(`Path "${dto.path}" does not exist on the server`);
        }
        const row = this.repo.create({ path: dto.path, label: dto.label });
        const saved = await this.repo.save(row);
        return this.enrich(saved);
    }
    async findAll() {
        const folders = await this.repo.find({ order: { path: 'ASC' } });
        return folders.map((f) => this.enrich(f));
    }
    async findOne(id) {
        const folder = await this.repo.findOne({ where: { id } });
        if (!folder)
            throw new common_1.NotFoundException(`Root folder #${id} not found`);
        return this.enrich(folder);
    }
    async remove(id) {
        const folder = await this.repo.findOne({ where: { id } });
        if (!folder)
            throw new common_1.NotFoundException(`Root folder #${id} not found`);
        await this.repo.remove(folder);
    }
};
exports.RootFoldersService = RootFoldersService;
exports.RootFoldersService = RootFoldersService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(root_folder_entity_1.RootFolder)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], RootFoldersService);
//# sourceMappingURL=root-folders.service.js.map