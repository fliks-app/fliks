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
var MovieDownloadService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MovieDownloadService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const media_entity_1 = require("./entities/media.entity");
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
const suitarr_qualities_1 = require("../../common/constants/suitarr-qualities");
const release_rejection_helper_1 = require("./release-rejection.helper");
function inferTitleFromTorrentUrl(url) {
    if (url.startsWith('magnet:')) {
        const m = url.match(/[?&]dn=([^&]+)/i);
        if (m) {
            try {
                return decodeURIComponent(m[1].replace(/\+/g, ' '));
            }
            catch {
                return m[1];
            }
        }
    }
    return url.slice(0, 240);
}
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
let MovieDownloadService = MovieDownloadService_1 = class MovieDownloadService {
    mediaRepo;
    historyRepo;
    indexerRepo;
    clientRepo;
    torznab;
    qbittorrent;
    customFormats;
    blocklist;
    notifications;
    qualityDefs;
    log = new common_1.Logger(MovieDownloadService_1.name);
    constructor(mediaRepo, historyRepo, indexerRepo, clientRepo, torznab, qbittorrent, customFormats, blocklist, notifications, qualityDefs) {
        this.mediaRepo = mediaRepo;
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
    async buildMovieReleaseRows(releases, media, indexers, allowed, allowedLangs) {
        const sizeByQuality = await this.qualityDefs.getSizeLimitsMap();
        const indexerMinSeeders = (0, release_rejection_helper_1.buildIndexerMinSeeders)(indexers);
        return Promise.all(releases.map(async (r) => {
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
        }));
    }
    searchIndexer(indexer, query) {
        return this.torznab.searchMovie(indexer, query);
    }
    searchQueryForMedia(media) {
        const parts = [media.title];
        if (media.year)
            parts.push(String(media.year));
        return parts.join(' ');
    }
    async searchMovieReleases(mediaId, customQuery) {
        const media = await this.mediaRepo.findOne({
            where: { id: mediaId },
            relations: ['qualityProfile', 'languageProfile'],
        });
        if (!media)
            throw new common_1.NotFoundException(`Media #${mediaId} not found`);
        if (media.type !== enums_1.MediaType.MOVIE) {
            throw new common_1.BadRequestException('Release search is only available for movies');
        }
        const allowed = this.allowedQualityIds(media.qualityProfile?.items);
        if (!allowed.size) {
            throw new common_1.BadRequestException('Assign a quality profile with at least one allowed quality to this movie');
        }
        const indexers = await this.indexerRepo.find({
            where: { enabled: true },
            order: { priority: 'ASC', id: 'ASC' },
        });
        const query = customQuery?.trim() || this.searchQueryForMedia(media);
        const batches = await Promise.all(indexers.map((ix) => this.searchIndexer(ix, query)));
        const flat = batches.flat();
        const allowedLangs = allowedLanguageIds(media.languageProfile?.languages);
        const rows = await this.buildMovieReleaseRows(flat, media, indexers, allowed, allowedLangs);
        rows.sort((a, b) => b.rank !== a.rank ? b.rank - a.rank : b.customFormatScore - a.customFormatScore);
        return rows;
    }
    async grabMovie(mediaId, dto) {
        const media = await this.mediaRepo.findOne({
            where: { id: mediaId },
            relations: ['qualityProfile', 'languageProfile'],
        });
        if (!media)
            throw new common_1.NotFoundException(`Media #${mediaId} not found`);
        if (media.type !== enums_1.MediaType.MOVIE) {
            throw new common_1.BadRequestException('Download grab is only available for movies');
        }
        const allowed = this.allowedQualityIds(media.qualityProfile?.items);
        if (!allowed.size) {
            throw new common_1.BadRequestException('Assign a quality profile with at least one allowed quality to this movie');
        }
        let downloadUrl = dto.downloadUrl?.trim();
        let sourceTitle = dto.sourceTitle?.trim();
        this.log.log(`grabMovie #${mediaId} "${media.title}" — manual URL: ${downloadUrl || '(auto)'}`);
        if (!downloadUrl) {
            const rows = await this.searchMovieReleases(mediaId);
            const pick = rows.find((r) => r.allowed && !r.blocklisted && r.languageAllowed && r.rejections.length === 0)
                ?? rows.find((r) => r.allowed && !r.blocklisted && r.languageAllowed);
            if (!pick) {
                throw new common_1.BadRequestException('No release matches the quality and language profiles. Add indexers or widen the profiles.');
            }
            downloadUrl = pick.downloadUrl;
            sourceTitle = pick.title;
            this.log.log(`Auto-picked: "${sourceTitle}" — ${downloadUrl}`);
        }
        else {
            if (!sourceTitle)
                sourceTitle = inferTitleFromTorrentUrl(downloadUrl);
            if (await this.blocklist.isBlocked(sourceTitle)) {
                throw new common_1.BadRequestException(`"${sourceTitle}" is in the blocklist and cannot be downloaded.`);
            }
        }
        const parsed = (0, release_quality_parser_1.parseReleaseQuality)(sourceTitle);
        if (!allowed.has(parsed.quality.id)) {
            throw new common_1.BadRequestException(`This release (${parsed.quality.name}) is not allowed by the movie quality profile`);
        }
        const clients = await this.clientRepo.find({
            order: { priority: 'ASC', id: 'ASC' },
        });
        const qbit = clients.find((c) => this.qbittorrent.supports(c));
        if (!qbit) {
            throw new common_1.BadRequestException('No enabled qBittorrent download client configured');
        }
        this.log.log(`Sending to qBittorrent: "${sourceTitle}" — ${downloadUrl}`);
        await this.qbittorrent.addTorrentUrl(qbit, downloadUrl, 'movie');
        this.log.log(`Grab successful for "${sourceTitle}"`);
        const row = this.historyRepo.create({
            mediaId: media.id,
            downloadClientId: qbit.id,
            sourceTitle,
            quality: parsed.quality.name,
            status: 'grabbed',
        });
        const saved = await this.historyRepo.save(row);
        void this.notifications.dispatch('grab.started', {
            title: media.title,
            quality: parsed.quality.name,
            sourceTitle,
        });
        return saved;
    }
    async searchUpgradeReleases(mediaId, customQuery) {
        const media = await this.mediaRepo.findOne({
            where: { id: mediaId },
            relations: ['qualityProfile', 'languageProfile', 'files'],
        });
        if (!media)
            throw new common_1.NotFoundException(`Media #${mediaId} not found`);
        if (media.type !== enums_1.MediaType.MOVIE) {
            throw new common_1.BadRequestException('Upgrade search is only available for movies');
        }
        const profile = media.qualityProfile;
        if (!profile?.upgradeAllowed) {
            throw new common_1.BadRequestException('Upgrade is not enabled for this quality profile');
        }
        const files = media.files ?? [];
        if (!files.length) {
            throw new common_1.BadRequestException('No file on disk — use the standard grab instead');
        }
        let currentRank = 0;
        for (const f of files) {
            const parsed = (0, release_quality_parser_1.parseReleaseQuality)(f.quality);
            if (parsed.quality.rank > currentRank)
                currentRank = parsed.quality.rank;
        }
        const cutoffQuality = (0, suitarr_qualities_1.getSuitarrQualityById)(profile.cutoff);
        const cutoffRank = cutoffQuality?.rank ?? 999;
        if (currentRank >= cutoffRank) {
            return [];
        }
        const allowed = this.allowedQualityIds(profile.items);
        const indexers = await this.indexerRepo.find({
            where: { enabled: true },
            order: { priority: 'ASC', id: 'ASC' },
        });
        const query = customQuery?.trim() || this.searchQueryForMedia(media);
        const batches = await Promise.all(indexers.map((ix) => this.searchIndexer(ix, query)));
        const flat = batches.flat();
        const allowedLangs = allowedLanguageIds(media.languageProfile?.languages);
        const rows = await this.buildMovieReleaseRows(flat, media, indexers, allowed, allowedLangs);
        return rows
            .filter((r) => r.rank > currentRank && r.rank <= cutoffRank)
            .sort((a, b) => b.rank !== a.rank ? b.rank - a.rank : b.customFormatScore - a.customFormatScore);
    }
    async grabUpgrade(mediaId, dto) {
        const media = await this.mediaRepo.findOne({
            where: { id: mediaId },
            relations: ['qualityProfile', 'languageProfile', 'files'],
        });
        if (!media)
            throw new common_1.NotFoundException(`Media #${mediaId} not found`);
        if (media.type !== enums_1.MediaType.MOVIE) {
            throw new common_1.BadRequestException('Upgrade grab is only available for movies');
        }
        const profile = media.qualityProfile;
        if (!profile?.upgradeAllowed) {
            throw new common_1.BadRequestException('Upgrade is not enabled for this quality profile');
        }
        const files = media.files ?? [];
        if (!files.length) {
            throw new common_1.BadRequestException('No file on disk — use the standard grab instead');
        }
        let currentRank = 0;
        for (const f of files) {
            const p = (0, release_quality_parser_1.parseReleaseQuality)(f.quality);
            if (p.quality.rank > currentRank)
                currentRank = p.quality.rank;
        }
        const cutoffQuality = (0, suitarr_qualities_1.getSuitarrQualityById)(profile.cutoff);
        const cutoffRank = cutoffQuality?.rank ?? 999;
        const allowed = this.allowedQualityIds(profile.items);
        let downloadUrl = dto.downloadUrl?.trim();
        let sourceTitle = dto.sourceTitle?.trim();
        this.log.log(`grabUpgrade #${mediaId} "${media.title}" — manual URL: ${downloadUrl || '(auto)'}`);
        if (!downloadUrl) {
            const upgrades = await this.searchUpgradeReleases(mediaId);
            const pick = upgrades.find((r) => r.allowed && !r.blocklisted && r.languageAllowed && r.rejections.length === 0)
                ?? upgrades.find((r) => r.allowed && !r.blocklisted && r.languageAllowed);
            if (!pick) {
                throw new common_1.BadRequestException('No upgrade release found that matches the quality and language profiles');
            }
            downloadUrl = pick.downloadUrl;
            sourceTitle = pick.title;
            this.log.log(`Upgrade auto-picked: "${sourceTitle}" — ${downloadUrl}`);
        }
        else {
            if (!sourceTitle)
                sourceTitle = inferTitleFromTorrentUrl(downloadUrl);
            if (await this.blocklist.isBlocked(sourceTitle)) {
                throw new common_1.BadRequestException(`"${sourceTitle}" is in the blocklist and cannot be downloaded.`);
            }
        }
        const parsed = (0, release_quality_parser_1.parseReleaseQuality)(sourceTitle);
        if (parsed.quality.rank <= currentRank) {
            throw new common_1.BadRequestException(`This release (${parsed.quality.name}) is not better than the current quality`);
        }
        if (parsed.quality.rank > cutoffRank) {
            throw new common_1.BadRequestException(`This release (${parsed.quality.name}) exceeds the cutoff quality`);
        }
        if (!allowed.has(parsed.quality.id)) {
            throw new common_1.BadRequestException(`This release (${parsed.quality.name}) is not allowed by the quality profile`);
        }
        const clients = await this.clientRepo.find({
            order: { priority: 'ASC', id: 'ASC' },
        });
        const qbit = clients.find((c) => this.qbittorrent.supports(c));
        if (!qbit) {
            throw new common_1.BadRequestException('No enabled qBittorrent download client configured');
        }
        this.log.log(`Sending upgrade to qBittorrent: "${sourceTitle}" — ${downloadUrl}`);
        await this.qbittorrent.addTorrentUrl(qbit, downloadUrl, 'movie');
        this.log.log(`Upgrade grab successful for "${sourceTitle}"`);
        const row = this.historyRepo.create({
            mediaId: media.id,
            downloadClientId: qbit.id,
            sourceTitle,
            quality: parsed.quality.name,
            status: 'grabbed',
        });
        const saved = await this.historyRepo.save(row);
        void this.notifications.dispatch('grab.started', {
            title: media.title,
            quality: parsed.quality.name,
            sourceTitle,
        });
        return saved;
    }
};
exports.MovieDownloadService = MovieDownloadService;
exports.MovieDownloadService = MovieDownloadService = MovieDownloadService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(media_entity_1.Media)),
    __param(1, (0, typeorm_1.InjectRepository)(download_history_entity_1.DownloadHistory)),
    __param(2, (0, typeorm_1.InjectRepository)(indexer_entity_1.Indexer)),
    __param(3, (0, typeorm_1.InjectRepository)(download_client_entity_1.DownloadClient)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        torznab_service_1.TorznabService,
        qbittorrent_service_1.QbittorrentService,
        custom_formats_service_1.CustomFormatsService,
        blocklist_service_1.BlocklistService,
        notifications_service_1.NotificationsService,
        quality_definitions_service_1.QualityDefinitionsService])
], MovieDownloadService);
//# sourceMappingURL=movie-download.service.js.map