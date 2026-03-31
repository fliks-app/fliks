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
var SchedulerService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchedulerService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const command_entity_1 = require("./entities/command.entity");
const media_entity_1 = require("../media/entities/media.entity");
const download_history_entity_1 = require("../media/entities/download-history.entity");
const season_entity_1 = require("../media/entities/season.entity");
const episode_entity_1 = require("../media/entities/episode.entity");
const indexer_entity_1 = require("../indexers/entities/indexer.entity");
const download_client_entity_1 = require("../download-clients/entities/download-client.entity");
const torznab_service_1 = require("../indexers/torznab.service");
const qbittorrent_service_1 = require("../download-clients/qbittorrent.service");
const tmdb_provider_1 = require("../metadata-providers/providers/tmdb.provider");
const media_service_1 = require("../media/media.service");
const enums_1 = require("../../common/enums");
const config_1 = require("@nestjs/config");
const completion_service_1 = require("./completion.service");
const naming_service_1 = require("./naming.service");
const delay_profile_entity_1 = require("../profiles/entities/delay-profile.entity");
const events_service_1 = require("./events.service");
let SchedulerService = SchedulerService_1 = class SchedulerService {
    commandRepo;
    mediaRepo;
    historyRepo;
    seasonRepo;
    episodeRepo;
    indexerRepo;
    clientRepo;
    torznab;
    qbittorrent;
    tmdb;
    mediaService;
    config;
    completion;
    naming;
    delayProfileRepo;
    eventsService;
    log = new common_1.Logger(SchedulerService_1.name);
    constructor(commandRepo, mediaRepo, historyRepo, seasonRepo, episodeRepo, indexerRepo, clientRepo, torznab, qbittorrent, tmdb, mediaService, config, completion, naming, delayProfileRepo, eventsService) {
        this.commandRepo = commandRepo;
        this.mediaRepo = mediaRepo;
        this.historyRepo = historyRepo;
        this.seasonRepo = seasonRepo;
        this.episodeRepo = episodeRepo;
        this.indexerRepo = indexerRepo;
        this.clientRepo = clientRepo;
        this.torznab = torznab;
        this.qbittorrent = qbittorrent;
        this.tmdb = tmdb;
        this.mediaService = mediaService;
        this.config = config;
        this.completion = completion;
        this.naming = naming;
        this.delayProfileRepo = delayProfileRepo;
        this.eventsService = eventsService;
    }
    async searchMissing() {
        return this.runCommand('SearchMissing', 'scheduled', () => this.doSearchMissing());
    }
    async refreshMetadata() {
        return this.runCommand('RefreshMetadata', 'scheduled', () => this.doRefreshMetadata());
    }
    async rssSync() {
        return this.runCommand('RssSync', 'scheduled', () => this.doRssSync());
    }
    async triggerCommand(name) {
        const known = ['SearchMissing', 'RefreshMetadata', 'RssSync', 'ImportCompleted'];
        if (!known.includes(name)) {
            throw new Error(`Unknown command: ${name}. Valid: ${known.join(', ')}`);
        }
        const cmd = await this.commandRepo.save(this.commandRepo.create({ name, status: 'queued', trigger: 'manual' }));
        this.dispatchCommand(name, cmd.id).catch((e) => this.log.error(`Command ${name} failed: ${e.message}`));
        return cmd;
    }
    getRecentCommands(limit = 50) {
        return this.commandRepo.find({
            order: { createdAt: 'DESC' },
            take: limit,
        });
    }
    async runCommand(name, trigger, fn) {
        const cmd = await this.commandRepo.save(this.commandRepo.create({ name, status: 'running', trigger, startedOn: new Date() }));
        try {
            await fn();
            cmd.status = 'completed';
        }
        catch (e) {
            this.log.error(`Command ${name} error: ${e.message}`);
            cmd.status = 'failed';
        }
        finally {
            cmd.endedOn = new Date();
            await this.commandRepo.save(cmd);
        }
    }
    async dispatchCommand(name, cmdId) {
        await this.commandRepo.update(cmdId, { status: 'running', startedOn: new Date() });
        try {
            if (name === 'SearchMissing')
                await this.doSearchMissing();
            else if (name === 'RefreshMetadata')
                await this.doRefreshMetadata();
            else if (name === 'RssSync')
                await this.doRssSync();
            else if (name === 'ImportCompleted')
                await this.completion.processCompleted();
            await this.commandRepo.update(cmdId, { status: 'completed', endedOn: new Date() });
        }
        catch (e) {
            await this.commandRepo.update(cmdId, { status: 'failed', endedOn: new Date() });
            throw e;
        }
    }
    async doSearchMissing() {
        const indexers = await this.indexerRepo.find({
            where: { enabled: true },
            order: { priority: 'ASC' },
        });
        const clients = await this.clientRepo.find({ where: { enabled: true } });
        const qbitClient = clients.find((c) => this.qbittorrent.supports(c));
        if (!indexers.length || !qbitClient) {
            this.log.warn('SearchMissing: no enabled indexers or download client');
            return;
        }
        await this.searchMissingMovies(indexers, qbitClient);
        await this.searchMissingEpisodes(indexers, qbitClient);
    }
    async searchMissingMovies(indexers, qbitClient) {
        const missing = await this.mediaRepo
            .createQueryBuilder('m')
            .leftJoin('m.files', 'f')
            .where('m.monitored = true')
            .andWhere('m.type = :type', { type: enums_1.MediaType.MOVIE })
            .andWhere('f.id IS NULL')
            .getMany();
        if (!missing.length)
            return;
        const today = new Date().toISOString().slice(0, 10);
        this.eventsService.emit({ command: 'SearchMissing', current: 0, total: missing.length, message: 'Searching movies...' });
        for (let i = 0; i < missing.length; i++) {
            const media = missing[i];
            if (!this.isAvailable(media, today)) {
                this.eventsService.emit({ command: 'SearchMissing', current: i + 1, total: missing.length, message: media.title });
                continue;
            }
            const pending = await this.historyRepo.findOne({
                where: { mediaId: media.id, status: 'grabbed' },
            });
            if (pending) {
                this.eventsService.emit({ command: 'SearchMissing', current: i + 1, total: missing.length, message: media.title });
                continue;
            }
            const query = [media.title, media.year].filter(Boolean).join(' ');
            const batches = await Promise.allSettled(indexers.map((ix) => this.torznab.searchMovie(ix, query)));
            const results = batches.flatMap((r) => r.status === 'fulfilled' ? r.value : []);
            if (!results.length) {
                this.eventsService.emit({ command: 'SearchMissing', current: i + 1, total: missing.length, message: media.title });
                continue;
            }
            const pick = results[0];
            try {
                await this.qbittorrent.addTorrentUrl(qbitClient, pick.downloadUrl, 'movie');
                await this.historyRepo.save(this.historyRepo.create({
                    mediaId: media.id,
                    downloadClientId: qbitClient.id,
                    indexerId: pick.indexerId,
                    sourceTitle: pick.title,
                    quality: this.naming.parseQuality(pick.title),
                    status: 'grabbed',
                }));
                this.log.log(`SearchMissing[movie]: grabbed "${pick.title}" for "${media.title}"`);
            }
            catch (e) {
                this.log.warn(`SearchMissing[movie]: grab failed for "${media.title}": ${e.message}`);
            }
            this.eventsService.emit({ command: 'SearchMissing', current: i + 1, total: missing.length, message: media.title });
        }
    }
    async searchMissingEpisodes(indexers, qbitClient) {
        const today = new Date().toISOString().slice(0, 10);
        const episodes = await this.episodeRepo
            .createQueryBuilder('ep')
            .innerJoin('ep.season', 'season')
            .innerJoin('season.media', 'media')
            .where('media.monitored = true')
            .andWhere('media.type = :type', { type: enums_1.MediaType.SERIES })
            .andWhere('season.monitored = true')
            .andWhere('ep.monitored = true')
            .andWhere('ep.hasFile = false')
            .andWhere('ep.airDate IS NOT NULL')
            .andWhere('ep.airDate <= :today', { today })
            .select(['ep.id', 'ep.episodeNumber', 'ep.title', 'ep.airDate'])
            .addSelect(['season.id', 'season.seasonNumber', 'season.mediaId'])
            .addSelect(['media.id', 'media.title', 'media.year'])
            .getMany();
        if (!episodes.length)
            return;
        this.eventsService.emit({ command: 'SearchMissing', current: 0, total: episodes.length, message: 'Searching episodes...' });
        for (let i = 0; i < episodes.length; i++) {
            const ep = episodes[i];
            const season = ep.season;
            const media = season.media;
            const pending = await this.historyRepo
                .createQueryBuilder('h')
                .where('h.mediaId = :mediaId', { mediaId: media.id })
                .andWhere('h.status = :status', { status: 'grabbed' })
                .andWhere(`h.sourceTitle ILIKE :pattern`, {
                pattern: `%S${String(season.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}%`,
            })
                .getOne();
            if (pending) {
                this.eventsService.emit({ command: 'SearchMissing', current: i + 1, total: episodes.length, message: media.title });
                continue;
            }
            const batches = await Promise.allSettled(indexers.map((ix) => this.torznab.searchSeries(ix, media.title, season.seasonNumber, ep.episodeNumber)));
            const results = batches.flatMap((r) => r.status === 'fulfilled' ? r.value : []);
            if (!results.length) {
                this.eventsService.emit({ command: 'SearchMissing', current: i + 1, total: episodes.length, message: media.title });
                continue;
            }
            const pick = results[0];
            try {
                await this.qbittorrent.addTorrentUrl(qbitClient, pick.downloadUrl, 'series');
                await this.historyRepo.save(this.historyRepo.create({
                    mediaId: media.id,
                    downloadClientId: qbitClient.id,
                    indexerId: pick.indexerId,
                    sourceTitle: pick.title,
                    quality: this.naming.parseQuality(pick.title),
                    status: 'grabbed',
                }));
                const epLabel = `S${String(season.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}`;
                this.log.log(`SearchMissing[series]: grabbed "${pick.title}" for "${media.title}" ${epLabel}`);
            }
            catch (e) {
                this.log.warn(`SearchMissing[series]: grab failed for "${media.title}" ep ${ep.id}: ${e.message}`);
            }
            this.eventsService.emit({ command: 'SearchMissing', current: i + 1, total: episodes.length, message: media.title });
        }
    }
    async doRefreshMetadata() {
        const apiKey = this.config.get('TMDB_API_KEY', '');
        if (!apiKey?.trim()) {
            this.log.warn('RefreshMetadata: TMDB_API_KEY not configured');
            return;
        }
        const allMedia = await this.mediaRepo.find({ where: { monitored: true } });
        let updated = 0;
        this.eventsService.emit({ command: 'RefreshMetadata', current: 0, total: allMedia.length, message: 'Refreshing metadata...' });
        for (let i = 0; i < allMedia.length; i++) {
            const media = allMedia[i];
            try {
                await this.mediaService.refreshMetadata(media.id);
                updated++;
            }
            catch (e) {
                this.log.warn(`RefreshMetadata: failed for "${media.title}": ${e.message}`);
            }
            this.eventsService.emit({ command: 'RefreshMetadata', current: i + 1, total: allMedia.length, message: media.title });
        }
        this.log.log(`RefreshMetadata: updated ${updated}/${allMedia.length} titles`);
    }
    async doRssSync() {
        const indexers = await this.indexerRepo.find({
            where: { enabled: true, enableRss: true },
            order: { priority: 'ASC' },
        });
        if (!indexers.length)
            return;
        const monitored = await this.mediaRepo.find({
            where: { monitored: true, type: enums_1.MediaType.MOVIE },
            select: ['id', 'title', 'year'],
            relations: ['tags'],
        });
        const clients = await this.clientRepo.find({ where: { enabled: true } });
        const qbitClient = clients.find((c) => this.qbittorrent.supports(c));
        if (!qbitClient)
            return;
        const delayProfiles = await this.delayProfileRepo.find({ order: { order: 'ASC' } });
        this.eventsService.emit({ command: 'RssSync', current: 0, total: indexers.length, message: 'RSS sync...' });
        for (let i = 0; i < indexers.length; i++) {
            const indexer = indexers[i];
            try {
                const results = await this.torznab.rssSearch(indexer);
                for (const release of results) {
                    const match = monitored.find((m) => release.title.toLowerCase().includes(m.title.toLowerCase()));
                    if (!match)
                        continue;
                    if (release.publishDate && this.isDelayed(match, release.publishDate, delayProfiles))
                        continue;
                    const alreadyGrabbed = await this.historyRepo.findOne({
                        where: { mediaId: match.id, sourceTitle: release.title },
                    });
                    if (alreadyGrabbed)
                        continue;
                    try {
                        await this.qbittorrent.addTorrentUrl(qbitClient, release.downloadUrl, 'movie');
                        await this.historyRepo.save(this.historyRepo.create({
                            mediaId: match.id,
                            downloadClientId: qbitClient.id,
                            indexerId: release.indexerId,
                            sourceTitle: release.title,
                            quality: this.naming.parseQuality(release.title),
                            status: 'grabbed',
                        }));
                        this.log.log(`RssSync: grabbed "${release.title}" for "${match.title}"`);
                    }
                    catch {
                    }
                }
            }
            catch (e) {
                this.log.warn(`RssSync: indexer "${indexer.name}" failed: ${e.message}`);
            }
            this.eventsService.emit({ command: 'RssSync', current: i + 1, total: indexers.length, message: indexer.name });
        }
    }
    isDelayed(media, publishDate, delayProfiles) {
        if (!delayProfiles.length)
            return false;
        const mediaTags = new Set((media.tags ?? []).map((t) => t.id));
        const profile = delayProfiles.find((dp) => {
            if (!dp.tags?.length)
                return true;
            return dp.tags.some((t) => mediaTags.has(t.id));
        });
        if (!profile || profile.torrentDelay <= 0)
            return false;
        const ageHours = (Date.now() - new Date(publishDate).getTime()) / 3_600_000;
        return ageHours < profile.torrentDelay;
    }
    isAvailable(media, today) {
        switch (media.minimumAvailability) {
            case enums_1.MinimumAvailability.ANNOUNCED:
                return true;
            case enums_1.MinimumAvailability.IN_CINEMAS:
                return !!(media.inCinemas && media.inCinemas <= today);
            case enums_1.MinimumAvailability.RELEASED:
                return !!((media.digitalRelease && media.digitalRelease <= today) ||
                    (media.physicalRelease && media.physicalRelease <= today));
            default:
                return true;
        }
    }
};
exports.SchedulerService = SchedulerService;
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_6_HOURS),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], SchedulerService.prototype, "searchMissing", null);
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_DAY_AT_4AM),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], SchedulerService.prototype, "refreshMetadata", null);
__decorate([
    (0, schedule_1.Cron)('*/15 * * * *'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], SchedulerService.prototype, "rssSync", null);
exports.SchedulerService = SchedulerService = SchedulerService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(command_entity_1.Command)),
    __param(1, (0, typeorm_1.InjectRepository)(media_entity_1.Media)),
    __param(2, (0, typeorm_1.InjectRepository)(download_history_entity_1.DownloadHistory)),
    __param(3, (0, typeorm_1.InjectRepository)(season_entity_1.Season)),
    __param(4, (0, typeorm_1.InjectRepository)(episode_entity_1.Episode)),
    __param(5, (0, typeorm_1.InjectRepository)(indexer_entity_1.Indexer)),
    __param(6, (0, typeorm_1.InjectRepository)(download_client_entity_1.DownloadClient)),
    __param(14, (0, typeorm_1.InjectRepository)(delay_profile_entity_1.DelayProfile)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        torznab_service_1.TorznabService,
        qbittorrent_service_1.QbittorrentService,
        tmdb_provider_1.TmdbProvider,
        media_service_1.MediaService,
        config_1.ConfigService,
        completion_service_1.CompletionService,
        naming_service_1.NamingService,
        typeorm_2.Repository,
        events_service_1.EventsService])
], SchedulerService);
//# sourceMappingURL=scheduler.service.js.map