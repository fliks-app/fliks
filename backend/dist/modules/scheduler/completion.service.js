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
var CompletionService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompletionService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const media_entity_1 = require("../media/entities/media.entity");
const media_file_entity_1 = require("../media/entities/media-file.entity");
const download_history_entity_1 = require("../media/entities/download-history.entity");
const season_entity_1 = require("../media/entities/season.entity");
const episode_entity_1 = require("../media/entities/episode.entity");
const download_client_entity_1 = require("../download-clients/entities/download-client.entity");
const root_folder_entity_1 = require("../root-folders/entities/root-folder.entity");
const qbittorrent_service_1 = require("../download-clients/qbittorrent.service");
const notifications_service_1 = require("../notifications/notifications.service");
const naming_service_1 = require("./naming.service");
let CompletionService = CompletionService_1 = class CompletionService {
    dataSource;
    mediaRepo;
    mediaFileRepo;
    historyRepo;
    seasonRepo;
    episodeRepo;
    clientRepo;
    rootFolderRepo;
    qbittorrent;
    notifications;
    naming;
    log = new common_1.Logger(CompletionService_1.name);
    constructor(dataSource, mediaRepo, mediaFileRepo, historyRepo, seasonRepo, episodeRepo, clientRepo, rootFolderRepo, qbittorrent, notifications, naming) {
        this.dataSource = dataSource;
        this.mediaRepo = mediaRepo;
        this.mediaFileRepo = mediaFileRepo;
        this.historyRepo = historyRepo;
        this.seasonRepo = seasonRepo;
        this.episodeRepo = episodeRepo;
        this.clientRepo = clientRepo;
        this.rootFolderRepo = rootFolderRepo;
        this.qbittorrent = qbittorrent;
        this.notifications = notifications;
        this.naming = naming;
    }
    async processCompleted() {
        const grabbed = await this.historyRepo.find({
            where: [{ status: 'grabbed' }, { status: 'failed' }],
        });
        if (!grabbed.length)
            return;
        this.log.log(`Import: ${grabbed.length} entries to process (grabbed + failed)`);
        const clients = await this.clientRepo.find({ where: { enabled: true } });
        const qbitClients = clients.filter((c) => this.qbittorrent.supports(c));
        if (!qbitClients.length) {
            this.log.warn('Import: no enabled qBittorrent client found');
            return;
        }
        const allTorrents = (await Promise.all(qbitClients.map((c) => this.qbittorrent.getTorrents(c)))).flat();
        this.log.log(`Import: ${allTorrents.length} torrents from ${qbitClients.length} client(s)`);
        const completedTorrents = allTorrents.filter((t) => t.progress >= 1 || t.state === 'seeding' || t.state === 'stalledUP');
        this.log.log(`Import: ${completedTorrents.length} completed torrents`);
        if (!completedTorrents.length)
            return;
        const fmtKeys = [
            'naming_movie_format',
            'naming_series_format',
            'naming_series_folder_format',
            'naming_season_folder_format',
        ];
        const fmtRows = await this.dataSource.query(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [fmtKeys]);
        const fmtMap = Object.fromEntries(fmtRows.map((r) => [r.key, r.value]));
        const movieFormat = fmtMap['naming_movie_format'] ?? '{Movie Title} ({Release Year}) {Quality Full}';
        const seriesFormat = fmtMap['naming_series_format'] ?? '{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}';
        const seriesFolderFormat = fmtMap['naming_series_folder_format'] ?? '{Series Title}';
        const seasonFolderFormat = fmtMap['naming_season_folder_format'] ?? 'Season {season:00}';
        const rootFolders = await this.rootFolderRepo.find({ order: { path: 'ASC' } });
        for (const history of grabbed) {
            const torrent = completedTorrents.find((t) => t.name.toLowerCase() === history.sourceTitle.toLowerCase() ||
                t.name.toLowerCase().startsWith(history.sourceTitle.toLowerCase()));
            if (!torrent) {
                this.log.debug(`Import: no completed torrent matching "${history.sourceTitle}" (mediaId=${history.mediaId})`);
                continue;
            }
            this.log.log(`Import: matched "${history.sourceTitle}" → torrent "${torrent.name}" (state=${torrent.state}, progress=${torrent.progress})`);
            try {
                await this.historyRepo.update(history.id, { status: 'importing' });
                await this.processOne(history, torrent, movieFormat, seriesFormat, seriesFolderFormat, seasonFolderFormat, rootFolders);
            }
            catch (e) {
                this.log.error(`Import: FAILED for "${history.sourceTitle}": ${e.message}`);
                await this.historyRepo.update(history.id, { status: 'failed' });
            }
        }
    }
    async processOne(history, torrent, movieFormat, seriesFormat, seriesFolderFormat, seasonFolderFormat, rootFolders) {
        const saveDir = path.join(torrent.save_path, torrent.name);
        const isDirTorrent = fs.existsSync(saveDir) && fs.statSync(saveDir).isDirectory();
        const searchDir = isDirTorrent ? saveDir : torrent.save_path;
        this.log.log(`Import[${history.sourceTitle}]: searching for video in "${searchDir}" (isDir=${isDirTorrent})`);
        let videoFile = this.naming.findLargestVideoFile(searchDir);
        if (!videoFile) {
            for (const ext of ['.mkv', '.mp4', '.avi', '.mov', '.ts']) {
                const candidate = path.join(torrent.save_path, torrent.name + ext);
                if (fs.existsSync(candidate)) {
                    const stat = fs.statSync(candidate);
                    videoFile = { filePath: candidate, size: stat.size };
                    break;
                }
            }
        }
        if (!videoFile) {
            this.log.warn(`Import[${history.sourceTitle}]: no video file found in "${searchDir}"`);
            return;
        }
        this.log.log(`Import[${history.sourceTitle}]: found video "${videoFile.filePath}" (${(videoFile.size / 1024 / 1024).toFixed(1)} MB)`);
        const media = await this.mediaRepo.findOne({ where: { id: history.mediaId } });
        if (!media) {
            this.log.warn(`Import[${history.sourceTitle}]: media id=${history.mediaId} not found in DB`);
            return;
        }
        this.log.log(`Import[${history.sourceTitle}]: media="${media.title}" (${media.type}, id=${media.id})`);
        const ext = path.extname(videoFile.filePath);
        const releaseGroup = this.naming.extractReleaseGroup(history.sourceTitle);
        let rootPath = media.path ?? '';
        if (!rootPath) {
            if (!rootFolders.length) {
                this.log.warn(`Import[${history.sourceTitle}]: no root folder configured, skipping`);
                return;
            }
            rootPath = rootFolders[0].path;
            this.log.log(`Import[${history.sourceTitle}]: no path on media, using root folder "${rootPath}"`);
        }
        else {
            this.log.log(`Import[${history.sourceTitle}]: using media path "${rootPath}"`);
        }
        let newFilename;
        let destDir;
        let episodeId;
        if (media.type === 'movie') {
            newFilename = this.naming.applyMovieFormat(movieFormat, {
                title: media.title,
                originalTitle: media.originalTitle,
                year: media.year,
                quality: history.quality,
                releaseGroup,
                tmdbId: media.tmdbId,
            });
            const safeTitle = media.title.replace(/[<>:"/\\|?*]/g, '').trim();
            destDir = path.join(rootPath, media.year ? `${safeTitle} (${media.year})` : safeTitle);
        }
        else {
            const epNums = this.naming.parseEpisodeNumbers(history.sourceTitle);
            let epTitle;
            let airDate;
            if (epNums) {
                const season = await this.seasonRepo.findOne({
                    where: { mediaId: media.id, seasonNumber: epNums.season },
                });
                if (season) {
                    const episode = await this.episodeRepo.findOne({
                        where: { seasonId: season.id, episodeNumber: epNums.episode },
                    });
                    if (episode) {
                        epTitle = episode.title ?? undefined;
                        airDate = episode.airDate ?? undefined;
                        episodeId = episode.id;
                    }
                }
            }
            newFilename = this.naming.applySeriesFormat(seriesFormat, {
                seriesTitle: media.title,
                season: epNums?.season ?? 1,
                episode: epNums?.episode ?? 1,
                episodeTitle: epTitle,
                quality: history.quality,
                releaseGroup,
                airDate,
            });
            const seriesFolder = this.naming.applySeriesFolderFormat(seriesFolderFormat, {
                seriesTitle: media.title,
                year: media.year,
                tmdbId: media.tmdbId,
            });
            const seasonFolder = this.naming.applySeasonFolderFormat(seasonFolderFormat, {
                season: epNums?.season ?? 1,
            });
            destDir = path.join(rootPath, seriesFolder, seasonFolder);
        }
        this.log.log(`Import[${history.sourceTitle}]: destDir="${destDir}", filename="${newFilename}${ext}"`);
        fs.mkdirSync(destDir, { recursive: true });
        const destPath = path.join(destDir, newFilename + ext);
        this.log.log(`Import[${history.sourceTitle}]: copying "${videoFile.filePath}" → "${destPath}"`);
        fs.copyFileSync(videoFile.filePath, destPath);
        this.log.log(`Import[${history.sourceTitle}]: copy OK`);
        if (!media.path) {
            await this.mediaRepo.update(media.id, { path: rootPath });
            this.log.log(`Import[${history.sourceTitle}]: saved root path "${rootPath}" on media`);
        }
        const relativePath = path.relative(destDir, destPath);
        await this.mediaFileRepo.save(this.mediaFileRepo.create({
            mediaId: media.id,
            episodeId,
            relativePath,
            size: videoFile.size,
            quality: history.quality,
        }));
        await this.historyRepo.update(history.id, { status: 'completed' });
        this.log.log(`Import[${history.sourceTitle}]: completed successfully`);
        void this.notifications.dispatch('download.complete', {
            title: media.title,
            quality: history.quality,
            sourceTitle: history.sourceTitle,
        });
    }
};
exports.CompletionService = CompletionService;
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_MINUTE),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], CompletionService.prototype, "processCompleted", null);
exports.CompletionService = CompletionService = CompletionService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(1, (0, typeorm_1.InjectRepository)(media_entity_1.Media)),
    __param(2, (0, typeorm_1.InjectRepository)(media_file_entity_1.MediaFile)),
    __param(3, (0, typeorm_1.InjectRepository)(download_history_entity_1.DownloadHistory)),
    __param(4, (0, typeorm_1.InjectRepository)(season_entity_1.Season)),
    __param(5, (0, typeorm_1.InjectRepository)(episode_entity_1.Episode)),
    __param(6, (0, typeorm_1.InjectRepository)(download_client_entity_1.DownloadClient)),
    __param(7, (0, typeorm_1.InjectRepository)(root_folder_entity_1.RootFolder)),
    __metadata("design:paramtypes", [typeorm_2.DataSource,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        qbittorrent_service_1.QbittorrentService,
        notifications_service_1.NotificationsService,
        naming_service_1.NamingService])
], CompletionService);
//# sourceMappingURL=completion.service.js.map