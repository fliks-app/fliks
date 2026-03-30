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
exports.DownloadClientsService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const download_client_entity_1 = require("./entities/download-client.entity");
const tag_entity_1 = require("../tags/entities/tag.entity");
const download_history_entity_1 = require("../media/entities/download-history.entity");
const qbittorrent_service_1 = require("./qbittorrent.service");
const QB_STATE_MAP = {
    error: 'Error',
    missingFiles: 'Missing files',
    uploading: 'Seeding',
    pausedUP: 'Paused',
    queuedUP: 'Queued',
    stalledUP: 'Seeding',
    checkingUP: 'Checking',
    forcedUP: 'Seeding',
    allocating: 'Allocating',
    downloading: 'Downloading',
    metaDL: 'Downloading metadata',
    pausedDL: 'Paused',
    queuedDL: 'Queued',
    stalledDL: 'Stalled',
    checkingDL: 'Checking',
    forcedDL: 'Downloading',
    forcedMetaDL: 'Downloading metadata',
    checkingResumeData: 'Checking',
    moving: 'Moving',
    stoppedUP: 'Stopped',
    stoppedDL: 'Stopped',
    unknown: 'Unknown',
};
let DownloadClientsService = class DownloadClientsService {
    repo;
    tagRepo;
    historyRepo;
    qbittorrent;
    constructor(repo, tagRepo, historyRepo, qbittorrent) {
        this.repo = repo;
        this.tagRepo = tagRepo;
        this.historyRepo = historyRepo;
        this.qbittorrent = qbittorrent;
    }
    async testConnection(dto) {
        return this.qbittorrent.testConnection(dto.settings);
    }
    async create(dto) {
        const { tagIds, ...fields } = dto;
        const row = this.repo.create({
            name: fields.name,
            implementation: fields.implementation,
            settings: fields.settings ?? {},
            enabled: fields.enabled ?? true,
            priority: fields.priority ?? 1,
        });
        if (tagIds?.length) {
            row.tags = await this.tagRepo.find({ where: { id: (0, typeorm_2.In)(tagIds) } });
        }
        return this.repo.save(row);
    }
    findAll() {
        return this.repo.find({ order: { priority: 'ASC', id: 'ASC' } });
    }
    async findOne(id) {
        const dc = await this.repo.findOne({ where: { id } });
        if (!dc)
            throw new common_1.NotFoundException(`Download client #${id} not found`);
        return dc;
    }
    async update(id, dto) {
        const dc = await this.findOne(id);
        const { tagIds, ...patch } = dto;
        if (patch.name !== undefined)
            dc.name = patch.name;
        if (patch.implementation !== undefined)
            dc.implementation = patch.implementation;
        if (patch.settings !== undefined)
            dc.settings = patch.settings;
        if (patch.enabled !== undefined)
            dc.enabled = patch.enabled;
        if (patch.priority !== undefined)
            dc.priority = patch.priority;
        if (tagIds !== undefined) {
            dc.tags = tagIds.length
                ? await this.tagRepo.find({ where: { id: (0, typeorm_2.In)(tagIds) } })
                : [];
        }
        return this.repo.save(dc);
    }
    async remove(id) {
        const dc = await this.findOne(id);
        await this.repo.remove(dc);
    }
    async removeTorrent(clientId, hash, deleteFiles) {
        const client = await this.findOne(clientId);
        if (!this.qbittorrent.supports(client)) {
            throw new common_1.NotFoundException('Client does not support torrent deletion');
        }
        await this.qbittorrent.deleteTorrent(client, hash, deleteFiles);
    }
    async getQueue() {
        const clients = await this.repo.find({ where: { enabled: true } });
        const results = [];
        for (const client of clients) {
            if (!this.qbittorrent.supports(client))
                continue;
            const torrents = await this.qbittorrent.getTorrents(client);
            for (const t of torrents) {
                results.push({
                    ...t,
                    clientId: client.id,
                    clientName: client.name,
                    status: QB_STATE_MAP[t.state] ?? t.state,
                });
            }
        }
        if (results.length === 0)
            return results;
        const historyEntries = await this.historyRepo.find({
            where: [{ status: 'grabbed' }, { status: 'completed' }, { status: 'failed' }, { status: 'importing' }],
            relations: ['media'],
        });
        const completedTitles = new Set(historyEntries
            .filter((h) => h.status === 'completed')
            .map((h) => h.sourceTitle.toLowerCase()));
        const filtered = [];
        for (const entry of results) {
            const name = entry.name.toLowerCase();
            const isCompleted = completedTitles.has(name) ||
                [...completedTitles].some((t) => name.startsWith(t));
            if (isCompleted)
                continue;
            const match = historyEntries.find((h) => h.sourceTitle.toLowerCase() === name ||
                name.startsWith(h.sourceTitle.toLowerCase()));
            if (match?.media) {
                entry.mediaId = match.mediaId;
                entry.mediaTitle = match.media.title;
                entry.mediaType = match.media.type;
            }
            const isSeeding = entry.status === 'Seeding';
            if (isSeeding && match) {
                if (match.status === 'failed')
                    entry.status = 'Import failed';
                else if (match.status === 'importing')
                    entry.status = 'Importing';
                else
                    entry.status = 'Awaiting import';
            }
            filtered.push(entry);
        }
        return filtered;
    }
};
exports.DownloadClientsService = DownloadClientsService;
exports.DownloadClientsService = DownloadClientsService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(download_client_entity_1.DownloadClient)),
    __param(1, (0, typeorm_1.InjectRepository)(tag_entity_1.Tag)),
    __param(2, (0, typeorm_1.InjectRepository)(download_history_entity_1.DownloadHistory)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        qbittorrent_service_1.QbittorrentService])
], DownloadClientsService);
//# sourceMappingURL=download-clients.service.js.map