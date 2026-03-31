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
var ImportSonarrService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImportSonarrService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const config_1 = require("@nestjs/config");
const typeorm_2 = require("typeorm");
const media_entity_1 = require("../media/entities/media.entity");
const root_folder_entity_1 = require("../root-folders/entities/root-folder.entity");
const quality_profile_entity_1 = require("../profiles/entities/quality-profile.entity");
const suitarr_qualities_1 = require("../../common/constants/suitarr-qualities");
const enums_1 = require("../../common/enums");
const pg_restore_import_util_1 = require("./pg-restore-import.util");
let ImportSonarrService = ImportSonarrService_1 = class ImportSonarrService {
    mediaRepo;
    rootFolderRepo;
    qpRepo;
    config;
    log = new common_1.Logger(ImportSonarrService_1.name);
    constructor(mediaRepo, rootFolderRepo, qpRepo, config) {
        this.mediaRepo = mediaRepo;
        this.rootFolderRepo = rootFolderRepo;
        this.qpRepo = qpRepo;
        this.config = config;
    }
    async importFromApi(url, apiKey) {
        const baseUrl = url.replace(/\/+$/, '');
        let imported = 0;
        const errors = [];
        const rootFoldersCreated = [];
        const qualityProfilesCreated = [];
        let series;
        try {
            const res = await fetch(`${baseUrl}/api/v3/series`, {
                headers: { 'X-Api-Key': apiKey },
            });
            if (!res.ok) {
                throw new common_1.BadRequestException(`Sonarr API returned ${res.status}: ${res.statusText}`);
            }
            series = (await res.json());
        }
        catch (e) {
            if (e instanceof common_1.BadRequestException)
                throw e;
            throw new common_1.BadRequestException(`Cannot connect to Sonarr: ${e.message}`);
        }
        if (!Array.isArray(series) || !series.length) {
            return {
                imported: 0,
                errors: ['No series found in Sonarr'],
                rootFoldersCreated,
                qualityProfilesCreated,
            };
        }
        await this.reconcileRootFolders(baseUrl, apiKey, rootFoldersCreated);
        const profileMap = await this.importQualityProfiles(baseUrl, apiKey, qualityProfilesCreated);
        for (const s of series) {
            const title = s.title ?? '';
            const tmdbId = Number(s.tmdbId || s.tvdbId);
            if (!Number.isFinite(tmdbId)) {
                errors.push(`${title || '(no title)'}: no valid tmdbId or tvdbId`);
                continue;
            }
            try {
                const exists = await this.mediaRepo.findOne({
                    where: { tmdbId, type: enums_1.MediaType.SERIES },
                });
                const localProfileId = s.qualityProfileId != null
                    ? profileMap.get(s.qualityProfileId)
                    : undefined;
                if (exists) {
                    await this.mediaRepo.remove(exists);
                }
                await this.mediaRepo.save(this.mediaRepo.create({
                    title,
                    tmdbId,
                    year: s.year ?? undefined,
                    type: enums_1.MediaType.SERIES,
                    status: enums_1.MediaStatus.CONTINUING,
                    monitored: s.monitored ?? true,
                    path: s.path || undefined,
                    imdbId: s.imdbId || undefined,
                    overview: s.overview || undefined,
                    qualityProfileId: localProfileId ?? undefined,
                }));
                imported++;
            }
            catch (e) {
                errors.push(`${title}: ${e.message}`);
            }
        }
        this.log.log(`Sonarr API import: ${imported} imported, ${errors.length} errors`);
        return {
            imported,
            errors,
            rootFoldersCreated,
            qualityProfilesCreated,
        };
    }
    async importQualityProfiles(baseUrl, apiKey, created) {
        const map = new Map();
        try {
            const res = await fetch(`${baseUrl}/api/v3/qualityprofile`, {
                headers: { 'X-Api-Key': apiKey },
            });
            if (!res.ok)
                return map;
            const remoteProfiles = (await res.json());
            const existingProfiles = await this.qpRepo.find();
            const existingByName = new Map(existingProfiles.map((p) => [p.name, p]));
            this.log.log(`Found ${remoteProfiles.length} quality profiles in Sonarr`);
            for (const remote of remoteProfiles) {
                const existing = existingByName.get(remote.name);
                if (existing) {
                    map.set(remote.id, existing.id);
                    this.log.log(`Quality profile "${remote.name}" already exists (local #${existing.id})`);
                    continue;
                }
                const items = this.mapRemoteItems(remote.items);
                const cutoffId = this.resolveCutoff(remote.cutoff, remote.items);
                const saved = await this.qpRepo.save(this.qpRepo.create({
                    name: remote.name,
                    cutoff: cutoffId,
                    upgradeAllowed: remote.upgradeAllowed,
                    items,
                }));
                map.set(remote.id, saved.id);
                created.push(remote.name);
                this.log.log(`Created quality profile from Sonarr: ${remote.name}`);
            }
        }
        catch (e) {
            this.log.warn(`Could not import Sonarr quality profiles: ${e.message}`);
        }
        return map;
    }
    mapRemoteItems(remoteItems) {
        const items = [];
        let sortOrder = 0;
        const addQuality = (name, allowed) => {
            const local = this.findLocalQuality(name);
            if (local) {
                items.push({
                    quality: {
                        id: local.id,
                        name: local.name,
                        resolution: local.resolution,
                        source: local.source,
                    },
                    allowed,
                    sortOrder: sortOrder++,
                });
            }
        };
        for (const item of remoteItems) {
            if (item.quality?.name) {
                addQuality(item.quality.name, item.allowed);
            }
            if (item.items?.length) {
                for (const sub of item.items) {
                    if (sub.quality?.name) {
                        addQuality(sub.quality.name, sub.allowed);
                    }
                }
            }
        }
        const presentIds = new Set(items.map((i) => i.quality.id));
        for (const q of suitarr_qualities_1.SUITARR_QUALITIES) {
            if (!presentIds.has(q.id)) {
                items.push({
                    quality: {
                        id: q.id,
                        name: q.name,
                        resolution: q.resolution,
                        source: q.source,
                    },
                    allowed: false,
                    sortOrder: sortOrder++,
                });
            }
        }
        return items;
    }
    findLocalQuality(remoteName) {
        const normalized = remoteName.replace(/[\s\-_]/g, '').toLowerCase();
        return suitarr_qualities_1.SUITARR_QUALITIES.find((q) => q.name.replace(/[\s\-_]/g, '').toLowerCase() === normalized);
    }
    resolveCutoff(remoteCutoffId, remoteItems) {
        const findName = (items) => {
            for (const item of items) {
                if (item.quality?.id === remoteCutoffId)
                    return item.quality.name;
                if (item.items?.length) {
                    const found = findName(item.items);
                    if (found)
                        return found;
                }
            }
            return undefined;
        };
        const name = findName(remoteItems);
        if (name) {
            const local = this.findLocalQuality(name);
            if (local)
                return local.id;
        }
        return 16;
    }
    async reconcileRootFolders(baseUrl, apiKey, rootFoldersCreated) {
        try {
            const rfRes = await fetch(`${baseUrl}/api/v3/rootfolder`, {
                headers: { 'X-Api-Key': apiKey },
            });
            if (rfRes.ok) {
                const remoteFolders = (await rfRes.json());
                const existing = await this.rootFolderRepo.find();
                const existingPaths = new Set(existing.map((f) => f.path.replace(/\/+$/, '')));
                for (const rf of remoteFolders) {
                    const normalized = rf.path.replace(/\/+$/, '');
                    if (!existingPaths.has(normalized)) {
                        try {
                            await this.rootFolderRepo.save(this.rootFolderRepo.create({ path: rf.path }));
                            rootFoldersCreated.push(rf.path);
                            this.log.log(`Created root folder from Sonarr: ${rf.path}`);
                        }
                        catch (e) {
                            this.log.warn(`Could not create root folder ${rf.path}: ${e.message}`);
                        }
                    }
                }
            }
        }
        catch (e) {
            this.log.warn(`Could not fetch Sonarr root folders: ${e.message}`);
        }
    }
    async importFromDump(buffer) {
        if (!buffer?.length) {
            throw new common_1.BadRequestException('Empty file');
        }
        let imported = 0;
        let skipped = 0;
        const errors = [];
        try {
            await (0, pg_restore_import_util_1.withTemporaryRestoredDatabase)(this.config, buffer, async (client) => {
                const rows = await (0, pg_restore_import_util_1.querySonarrSeries)(client);
                if (!rows.length) {
                    errors.push('No series found in database');
                    return;
                }
                for (const row of rows) {
                    const title = row.title ?? '';
                    const externalId = Number(row.externalId);
                    if (!Number.isFinite(externalId)) {
                        errors.push(`${title || '(no title)'}: invalid external id`);
                        continue;
                    }
                    try {
                        const exists = await this.mediaRepo.findOne({
                            where: { tmdbId: externalId, type: enums_1.MediaType.SERIES },
                        });
                        if (exists) {
                            skipped++;
                            continue;
                        }
                        await this.mediaRepo.save(this.mediaRepo.create({
                            title,
                            tmdbId: externalId,
                            year: row.year ?? undefined,
                            type: enums_1.MediaType.SERIES,
                            status: enums_1.MediaStatus.CONTINUING,
                            monitored: (0, pg_restore_import_util_1.rowMonitored)(row.monitored),
                            path: row.path || undefined,
                        }));
                        imported++;
                    }
                    catch (e) {
                        errors.push(`${title}: ${e.message}`);
                    }
                }
            });
        }
        catch (e) {
            throw new common_1.BadRequestException(e.message);
        }
        this.log.log(`Sonarr import: ${imported} imported, ${skipped} skipped, ${errors.length} errors`);
        return { imported, skipped, errors };
    }
};
exports.ImportSonarrService = ImportSonarrService;
exports.ImportSonarrService = ImportSonarrService = ImportSonarrService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(media_entity_1.Media)),
    __param(1, (0, typeorm_1.InjectRepository)(root_folder_entity_1.RootFolder)),
    __param(2, (0, typeorm_1.InjectRepository)(quality_profile_entity_1.QualityProfile)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        config_1.ConfigService])
], ImportSonarrService);
//# sourceMappingURL=import-sonarr.service.js.map