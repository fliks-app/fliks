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
exports.DiskImportService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const media_entity_1 = require("./entities/media.entity");
const media_file_entity_1 = require("./entities/media-file.entity");
const season_entity_1 = require("./entities/season.entity");
const episode_entity_1 = require("./entities/episode.entity");
const release_quality_parser_1 = require("./release-quality.parser");
const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.ts', '.m2ts', '.wmv', '.flv']);
let DiskImportService = class DiskImportService {
    mediaRepo;
    fileRepo;
    seasonRepo;
    episodeRepo;
    constructor(mediaRepo, fileRepo, seasonRepo, episodeRepo) {
        this.mediaRepo = mediaRepo;
        this.fileRepo = fileRepo;
        this.seasonRepo = seasonRepo;
        this.episodeRepo = episodeRepo;
    }
    async scanFolder(folderPath) {
        const resolved = path.resolve(folderPath);
        let stat;
        try {
            stat = fs.statSync(resolved);
        }
        catch {
            throw new common_1.BadRequestException(`Path "${resolved}" does not exist or is not accessible`);
        }
        if (!stat.isDirectory()) {
            throw new common_1.BadRequestException(`Path "${resolved}" is not a directory`);
        }
        const videoFiles = this.collectVideoFiles(resolved, 0);
        if (!videoFiles.length)
            return [];
        const allMedia = await this.mediaRepo.find({
            select: ['id', 'title', 'originalTitle', 'year', 'type'],
        });
        return Promise.all(videoFiles.map((f) => this.buildCandidate(f, allMedia)));
    }
    async confirmImport(imports) {
        let imported = 0;
        const errors = [];
        for (const entry of imports) {
            try {
                const media = await this.mediaRepo.findOne({ where: { id: entry.mediaId } });
                if (!media) {
                    errors.push(`Media #${entry.mediaId} not found`);
                    continue;
                }
                let fileSize = 0;
                try {
                    fileSize = fs.statSync(entry.filePath).size;
                }
                catch {
                }
                if (!media.path) {
                    const dir = path.dirname(entry.filePath);
                    await this.mediaRepo.update(media.id, { path: dir });
                    media.path = dir;
                }
                const relativePath = path.relative(media.path, entry.filePath);
                const existing = await this.fileRepo.findOne({
                    where: { mediaId: media.id, relativePath },
                });
                if (existing)
                    continue;
                await this.fileRepo.save(this.fileRepo.create({
                    mediaId: media.id,
                    episodeId: entry.episodeId ?? undefined,
                    relativePath,
                    size: fileSize,
                    quality: entry.quality,
                }));
                if (entry.episodeId) {
                    await this.episodeRepo.update(entry.episodeId, { hasFile: true });
                }
                imported++;
            }
            catch (e) {
                errors.push(`${path.basename(entry.filePath)}: ${e.message}`);
            }
        }
        return { imported, errors };
    }
    collectVideoFiles(dir, depth) {
        if (depth > 3)
            return [];
        const files = [];
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return [];
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                files.push(...this.collectVideoFiles(fullPath, depth + 1));
            }
            else if (VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) {
                files.push(fullPath);
            }
        }
        return files;
    }
    async buildCandidate(filePath, allMedia) {
        const filename = path.basename(filePath);
        let size = 0;
        try {
            size = fs.statSync(filePath).size;
        }
        catch {
        }
        const { quality } = (0, release_quality_parser_1.parseReleaseQuality)(filename);
        const epNums = this.parseEpisodeNumbers(filename);
        const extractedTitle = this.extractTitle(filename);
        const matched = this.matchMedia(extractedTitle, allMedia);
        let episodeId = null;
        let episodeTitle = null;
        if (matched?.type === 'series' && epNums) {
            const season = await this.seasonRepo.findOne({
                where: { mediaId: matched.id, seasonNumber: epNums.season },
            });
            if (season) {
                const ep = await this.episodeRepo.findOne({
                    where: { seasonId: season.id, episodeNumber: epNums.episode },
                });
                if (ep) {
                    episodeId = ep.id;
                    episodeTitle = ep.title ?? null;
                }
            }
        }
        return {
            filePath,
            filename,
            size,
            qualityName: quality.name,
            qualityId: quality.id,
            seasonNumber: epNums?.season ?? null,
            episodeNumber: epNums?.episode ?? null,
            mediaId: matched?.id ?? null,
            mediaTitle: matched?.title ?? null,
            mediaYear: matched?.year ?? null,
            mediaType: matched?.type ?? null,
            episodeId,
            episodeTitle,
        };
    }
    extractTitle(filename) {
        let name = path.basename(filename, path.extname(filename));
        name = name.replace(/[._]/g, ' ');
        name = name.replace(/\s*\b(2160|4k|uhd|1080|720|480p?)\b.*/i, '');
        name = name.replace(/\s*\b(bluray|blu.?ray|web.?dl|web.?rip|hdtv|dvdrip|bdrip|remux)\b.*/i, '');
        name = name.replace(/\s*\b(x264|x265|xvid|h264|h265|hevc|avc)\b.*/i, '');
        name = name.replace(/\s*[Ss]\d{1,2}[Ee]\d{1,3}.*/i, '');
        name = name.replace(/\s*[\[(]?\d{4}[\])]?\s*$/, '');
        return name.trim().toLowerCase();
    }
    matchMedia(extractedTitle, allMedia) {
        const norm = (s) => s
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        const target = norm(extractedTitle);
        if (!target)
            return null;
        let match = allMedia.find((m) => norm(m.title) === target || norm(m.originalTitle ?? '') === target);
        if (match)
            return match;
        match = allMedia.find((m) => {
            const mt = norm(m.title);
            return mt.length >= 2 && target.startsWith(mt);
        });
        if (match)
            return match;
        match = allMedia.find((m) => {
            const mt = norm(m.title);
            return mt.length >= 3 && mt.startsWith(target);
        });
        return match ?? null;
    }
    parseEpisodeNumbers(filename) {
        const m = filename.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
        if (!m)
            return null;
        return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
    }
};
exports.DiskImportService = DiskImportService;
exports.DiskImportService = DiskImportService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(media_entity_1.Media)),
    __param(1, (0, typeorm_1.InjectRepository)(media_file_entity_1.MediaFile)),
    __param(2, (0, typeorm_1.InjectRepository)(season_entity_1.Season)),
    __param(3, (0, typeorm_1.InjectRepository)(episode_entity_1.Episode)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository])
], DiskImportService);
//# sourceMappingURL=disk-import.service.js.map