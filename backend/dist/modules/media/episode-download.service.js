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
var EpisodeDownloadService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.EpisodeDownloadService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const media_entity_1 = require("./entities/media.entity");
const season_entity_1 = require("./entities/season.entity");
const episode_entity_1 = require("./entities/episode.entity");
const download_history_entity_1 = require("./entities/download-history.entity");
const indexer_entity_1 = require("../indexers/entities/indexer.entity");
const download_client_entity_1 = require("../download-clients/entities/download-client.entity");
const torznab_service_1 = require("../indexers/torznab.service");
const qbittorrent_service_1 = require("../download-clients/qbittorrent.service");
const release_quality_parser_1 = require("./release-quality.parser");
const release_language_parser_1 = require("./release-language.parser");
const custom_formats_service_1 = require("../profiles/custom-formats.service");
const quality_definitions_service_1 = require("../profiles/quality-definitions.service");
const blocklist_service_1 = require("../blocklist/blocklist.service");
const notifications_service_1 = require("../notifications/notifications.service");
const enums_1 = require("../../common/enums");
function allowedLanguageIds(items) {
    const set = new Set();
    if (!items?.length)
        return set;
    for (const row of items) {
        if (row.allowed)
            set.add(row.language.id);
    }
    return set;
}
const release_rejection_helper_1 = require("./release-rejection.helper");
let EpisodeDownloadService = EpisodeDownloadService_1 = class EpisodeDownloadService {
    mediaRepo;
    seasonRepo;
    episodeRepo;
    historyRepo;
    indexerRepo;
    clientRepo;
    torznab;
    qbittorrent;
    customFormats;
    blocklist;
    notifications;
    qualityDefs;
    log = new common_1.Logger(EpisodeDownloadService_1.name);
    constructor(mediaRepo, seasonRepo, episodeRepo, historyRepo, indexerRepo, clientRepo, torznab, qbittorrent, customFormats, blocklist, notifications, qualityDefs) {
        this.mediaRepo = mediaRepo;
        this.seasonRepo = seasonRepo;
        this.episodeRepo = episodeRepo;
        this.historyRepo = historyRepo;
        this.indexerRepo = indexerRepo;
        this.clientRepo = clientRepo;
        this.torznab = torznab;
        this.qbittorrent = qbittorrent;
        this.customFormats = customFormats;
        this.blocklist = blocklist;
        this.notifications = notifications;
        this.qualityDefs = qualityDefs;
    }
    allowedQualityIds(items) {
        return (0, release_rejection_helper_1.buildAllowedQualityIds)(items);
    }
    async getEpisodeWithContext(mediaId, episodeId) {
        const media = await this.mediaRepo.findOne({
            where: { id: mediaId },
            relations: ['qualityProfile', 'languageProfile'],
        });
        if (!media)
            throw new common_1.NotFoundException(`Media #${mediaId} not found`);
        if (media.type !== enums_1.MediaType.SERIES) {
            throw new common_1.BadRequestException('Episode grab is only available for series');
        }
        const episode = await this.episodeRepo.findOne({
            where: { id: episodeId },
            relations: ['season'],
        });
        if (!episode)
            throw new common_1.NotFoundException(`Episode #${episodeId} not found`);
        if (episode.season.mediaId !== mediaId) {
            throw new common_1.BadRequestException('Episode does not belong to this media');
        }
        return { media, episode, season: episode.season };
    }
    async searchEpisodeReleases(mediaId, episodeId, customQuery) {
        const { media, episode, season } = await this.getEpisodeWithContext(mediaId, episodeId);
        const allowed = this.allowedQualityIds(media.qualityProfile?.items);
        if (!allowed.size) {
            throw new common_1.BadRequestException('Assign a quality profile with at least one allowed quality to this series');
        }
        const indexers = await this.indexerRepo.find({
            where: { enabled: true },
            order: { priority: 'ASC', id: 'ASC' },
        });
        const allowedLangs = allowedLanguageIds(media.languageProfile?.languages);
        const sizeByQuality = await this.qualityDefs.getSizeLimitsMap();
        const indexerMinSeeders = (0, release_rejection_helper_1.buildIndexerMinSeeders)(indexers);
        const searchQuery = customQuery?.trim();
        const batches = await Promise.all(searchQuery
            ? indexers.map((ix) => this.torznab.searchSeries(ix, searchQuery, season.seasonNumber, episode.episodeNumber))
            : indexers.map((ix) => this.torznab.searchSeries(ix, media.title, season.seasonNumber, episode.episodeNumber)));
        const flat = batches.flat();
        const rows = await Promise.all(flat.map((r) => this.buildReleaseRow(r, allowed, allowedLangs, sizeByQuality, indexerMinSeeders)));
        rows.sort((a, b) => b.rank !== a.rank ? b.rank - a.rank : b.customFormatScore - a.customFormatScore);
        return rows;
    }
    async grabEpisode(mediaId, episodeId, dto) {
        const { media, episode, season } = await this.getEpisodeWithContext(mediaId, episodeId);
        const allowed = this.allowedQualityIds(media.qualityProfile?.items);
        if (!allowed.size) {
            throw new common_1.BadRequestException('Assign a quality profile with at least one allowed quality to this series');
        }
        let downloadUrl = dto?.downloadUrl?.trim();
        let sourceTitle = dto?.sourceTitle?.trim();
        const epLabel = `S${String(season.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')}`;
        this.log.log(`grabEpisode #${mediaId} "${media.title}" ${epLabel} — manual URL: ${downloadUrl || '(auto)'}`);
        if (!downloadUrl) {
            const rows = await this.searchEpisodeReleases(mediaId, episodeId);
            const pick = rows.find((r) => r.allowed && !r.blocklisted && r.rejections.length === 0)
                ?? rows.find((r) => r.allowed && !r.blocklisted);
            if (!pick) {
                throw new common_1.BadRequestException('No release matches the quality and language profiles. Add indexers or widen the profiles.');
            }
            downloadUrl = pick.downloadUrl;
            sourceTitle = pick.title;
            this.log.log(`Auto-picked: "${sourceTitle}" — ${downloadUrl}`);
        }
        else {
            if (!sourceTitle)
                sourceTitle = downloadUrl.slice(0, 240);
            if (await this.blocklist.isBlocked(sourceTitle)) {
                throw new common_1.BadRequestException(`"${sourceTitle}" is in the blocklist and cannot be downloaded.`);
            }
        }
        const parsed = (0, release_quality_parser_1.parseReleaseQuality)(sourceTitle);
        if (!allowed.has(parsed.quality.id)) {
            throw new common_1.BadRequestException(`This release (${parsed.quality.name}) is not allowed by the series quality profile`);
        }
        const clients = await this.clientRepo.find({
            order: { priority: 'ASC', id: 'ASC' },
        });
        const qbit = clients.find((c) => this.qbittorrent.supports(c));
        if (!qbit) {
            throw new common_1.BadRequestException('No enabled qBittorrent download client configured');
        }
        this.log.log(`Sending to qBittorrent: "${sourceTitle}" — ${downloadUrl}`);
        await this.qbittorrent.addTorrentUrl(qbit, downloadUrl, 'series');
        this.log.log(`Grab successful for "${sourceTitle}"`);
        const row = this.historyRepo.create({
            mediaId: media.id,
            downloadClientId: qbit.id,
            sourceTitle: sourceTitle,
            quality: parsed.quality.name,
            status: 'grabbed',
        });
        const saved = await this.historyRepo.save(row);
        void this.notifications.dispatch('grab.started', {
            title: `${media.title} ${epLabel}`,
            quality: parsed.quality.name,
            sourceTitle,
        });
        return saved;
    }
    async buildReleaseRow(r, allowed, allowedLangs, sizeByQuality, indexerMinSeeders) {
        const parsed = (0, release_quality_parser_1.parseReleaseQuality)(r.title);
        const lang = (0, release_language_parser_1.parseReleaseLanguage)(r.title);
        const [cfScore, isBlocklisted] = await Promise.all([
            this.customFormats.scoreRelease(r.title, { freeleech: r.freeleech, downloadVolumeFactor: r.downloadVolumeFactor }),
            this.blocklist.isBlocked(r.title),
        ]);
        const rejections = (0, release_rejection_helper_1.computeRejections)({
            qualityId: parsed.quality.id,
            allowed,
            languageId: lang.id,
            allowedLangs,
            isBlocklisted,
            sizeBytes: r.size,
            sizeByQuality,
            seeders: r.seeders,
            indexerId: r.indexerId,
            indexerMinSeeders,
        });
        return {
            title: r.title,
            downloadUrl: r.downloadUrl,
            qualityId: parsed.quality.id,
            qualityName: parsed.quality.name,
            rank: parsed.quality.rank,
            allowed: allowed.has(parsed.quality.id),
            customFormatScore: cfScore,
            blocklisted: isBlocklisted,
            indexerId: r.indexerId,
            indexerName: r.indexerName,
            languageId: lang.id,
            languageName: lang.name,
            languageAllowed: allowedLangs.size === 0 || allowedLangs.has(lang.id),
            size: r.size,
            seeders: r.seeders,
            leechers: r.leechers,
            rejections,
            freeleech: r.freeleech,
            downloadVolumeFactor: r.downloadVolumeFactor,
        };
    }
    async searchSeasonReleases(mediaId, seasonId, customQuery) {
        const media = await this.mediaRepo.findOne({
            where: { id: mediaId },
            relations: ['qualityProfile', 'languageProfile'],
        });
        if (!media)
            throw new common_1.NotFoundException(`Media #${mediaId} not found`);
        if (media.type !== enums_1.MediaType.SERIES) {
            throw new common_1.BadRequestException('Season search is only available for series');
        }
        const season = await this.seasonRepo.findOne({ where: { id: seasonId } });
        if (!season || season.mediaId !== mediaId) {
            throw new common_1.NotFoundException(`Season #${seasonId} not found on this media`);
        }
        const allowed = this.allowedQualityIds(media.qualityProfile?.items);
        if (!allowed.size) {
            throw new common_1.BadRequestException('Assign a quality profile with at least one allowed quality to this series');
        }
        const indexers = await this.indexerRepo.find({
            where: { enabled: true },
            order: { priority: 'ASC', id: 'ASC' },
        });
        const allowedLangs = allowedLanguageIds(media.languageProfile?.languages);
        const sizeByQuality = await this.qualityDefs.getSizeLimitsMap();
        const indexerMinSeeders = (0, release_rejection_helper_1.buildIndexerMinSeeders)(indexers);
        const searchTitle = customQuery?.trim() || media.title;
        const batches = await Promise.all(indexers.map((ix) => this.torznab.searchSeasonPack(ix, searchTitle, season.seasonNumber)));
        const rows = await Promise.all(batches.flat().map((r) => this.buildReleaseRow(r, allowed, allowedLangs, sizeByQuality, indexerMinSeeders)));
        rows.sort((a, b) => b.rank !== a.rank ? b.rank - a.rank : b.customFormatScore - a.customFormatScore);
        return rows;
    }
    async grabSeason(mediaId, seasonId, dto) {
        const media = await this.mediaRepo.findOne({
            where: { id: mediaId },
            relations: ['qualityProfile', 'languageProfile'],
        });
        if (!media)
            throw new common_1.NotFoundException(`Media #${mediaId} not found`);
        if (media.type !== enums_1.MediaType.SERIES) {
            throw new common_1.BadRequestException('Season grab is only available for series');
        }
        const season = await this.seasonRepo.findOne({
            where: { id: seasonId },
            relations: ['episodes'],
        });
        if (!season || season.mediaId !== mediaId) {
            throw new common_1.NotFoundException(`Season #${seasonId} not found on this media`);
        }
        const allowed = this.allowedQualityIds(media.qualityProfile?.items);
        if (!allowed.size) {
            throw new common_1.BadRequestException('Assign a quality profile with at least one allowed quality to this series');
        }
        const clients = await this.clientRepo.find({ order: { priority: 'ASC', id: 'ASC' } });
        const qbit = clients.find((c) => this.qbittorrent.supports(c));
        if (!qbit) {
            throw new common_1.BadRequestException('No enabled qBittorrent download client configured');
        }
        this.log.log(`grabSeason #${mediaId} S${String(season.seasonNumber).padStart(2, '0')} — manual URL: ${dto?.downloadUrl?.trim() || '(auto)'}`);
        if (dto?.downloadUrl?.trim()) {
            const downloadUrl = dto.downloadUrl.trim();
            const sourceTitle = dto.sourceTitle?.trim() || downloadUrl.slice(0, 240);
            if (await this.blocklist.isBlocked(sourceTitle)) {
                throw new common_1.BadRequestException(`"${sourceTitle}" is in the blocklist`);
            }
            const parsed = (0, release_quality_parser_1.parseReleaseQuality)(sourceTitle);
            await this.qbittorrent.addTorrentUrl(qbit, downloadUrl, 'series');
            await this.historyRepo.save(this.historyRepo.create({
                mediaId,
                downloadClientId: qbit.id,
                sourceTitle,
                quality: parsed.quality.name,
                status: 'grabbed',
            }));
            void this.notifications.dispatch('grab.started', {
                title: `${media.title} S${String(season.seasonNumber).padStart(2, '0')}`,
                quality: parsed.quality.name,
                sourceTitle,
            });
            return { grabbed: 1, errors: [] };
        }
        const indexers = await this.indexerRepo.find({
            where: { enabled: true },
            order: { priority: 'ASC', id: 'ASC' },
        });
        const allowedLangs = allowedLanguageIds(media.languageProfile?.languages);
        const sizeByQuality = await this.qualityDefs.getSizeLimitsMap();
        const indexerMinSeeders = (0, release_rejection_helper_1.buildIndexerMinSeeders)(indexers);
        const packBatches = await Promise.all(indexers.map((ix) => this.torznab.searchSeasonPack(ix, media.title, season.seasonNumber)));
        const packRows = await Promise.all(packBatches.flat().map((r) => this.buildReleaseRow(r, allowed, allowedLangs, sizeByQuality, indexerMinSeeders)));
        packRows.sort((a, b) => b.rank !== a.rank ? b.rank - a.rank : b.customFormatScore - a.customFormatScore);
        const bestPack = packRows.find((r) => r.allowed && !r.blocklisted && r.rejections.length === 0);
        if (bestPack) {
            this.log.log(`Season pack found: "${bestPack.title}" — ${bestPack.downloadUrl}`);
            await this.qbittorrent.addTorrentUrl(qbit, bestPack.downloadUrl, 'series');
            await this.historyRepo.save(this.historyRepo.create({
                mediaId,
                downloadClientId: qbit.id,
                sourceTitle: bestPack.title,
                quality: bestPack.qualityName,
                status: 'grabbed',
            }));
            void this.notifications.dispatch('grab.started', {
                title: `${media.title} S${String(season.seasonNumber).padStart(2, '0')}`,
                quality: bestPack.qualityName,
                sourceTitle: bestPack.title,
            });
            return { grabbed: 1, errors: [] };
        }
        this.log.log(`No season pack found, falling back to per-episode grab`);
        const today = new Date().toISOString().slice(0, 10);
        const missingEpisodes = (season.episodes ?? []).filter((ep) => ep.monitored && !ep.hasFile && ep.airDate && ep.airDate <= today);
        let grabbed = 0;
        const errors = [];
        for (const ep of missingEpisodes) {
            try {
                const epBatches = await Promise.all(indexers.map((ix) => this.torznab.searchSeries(ix, media.title, season.seasonNumber, ep.episodeNumber)));
                const epRows = await Promise.all(epBatches.flat().map((r) => this.buildReleaseRow(r, allowed, allowedLangs, sizeByQuality, indexerMinSeeders)));
                epRows.sort((a, b) => b.rank !== a.rank ? b.rank - a.rank : b.customFormatScore - a.customFormatScore);
                const pick = epRows.find((r) => r.allowed && !r.blocklisted && r.rejections.length === 0);
                if (!pick)
                    continue;
                await this.qbittorrent.addTorrentUrl(qbit, pick.downloadUrl, 'series');
                await this.historyRepo.save(this.historyRepo.create({
                    mediaId,
                    downloadClientId: qbit.id,
                    sourceTitle: pick.title,
                    quality: pick.qualityName,
                    status: 'grabbed',
                }));
                grabbed++;
            }
            catch (e) {
                const epLabel = `S${String(season.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}`;
                errors.push(`${epLabel}: ${e.message}`);
            }
        }
        if (grabbed === 0 && errors.length === 0) {
            errors.push('No matching release found for any episode in this season');
        }
        return { grabbed, errors };
    }
};
exports.EpisodeDownloadService = EpisodeDownloadService;
exports.EpisodeDownloadService = EpisodeDownloadService = EpisodeDownloadService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(media_entity_1.Media)),
    __param(1, (0, typeorm_1.InjectRepository)(season_entity_1.Season)),
    __param(2, (0, typeorm_1.InjectRepository)(episode_entity_1.Episode)),
    __param(3, (0, typeorm_1.InjectRepository)(download_history_entity_1.DownloadHistory)),
    __param(4, (0, typeorm_1.InjectRepository)(indexer_entity_1.Indexer)),
    __param(5, (0, typeorm_1.InjectRepository)(download_client_entity_1.DownloadClient)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        torznab_service_1.TorznabService,
        qbittorrent_service_1.QbittorrentService,
        custom_formats_service_1.CustomFormatsService,
        blocklist_service_1.BlocklistService,
        notifications_service_1.NotificationsService,
        quality_definitions_service_1.QualityDefinitionsService])
], EpisodeDownloadService);
//# sourceMappingURL=episode-download.service.js.map