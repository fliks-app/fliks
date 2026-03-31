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
exports.MediaController = void 0;
const common_1 = require("@nestjs/common");
const media_service_1 = require("./media.service");
const movie_download_service_1 = require("./movie-download.service");
const episode_download_service_1 = require("./episode-download.service");
const disk_import_service_1 = require("./disk-import.service");
const create_media_dto_1 = require("./dto/create-media.dto");
const update_media_dto_1 = require("./dto/update-media.dto");
const search_media_dto_1 = require("./dto/search-media.dto");
const import_tmdb_dto_1 = require("./dto/import-tmdb.dto");
const grab_movie_dto_1 = require("./dto/grab-movie.dto");
const scan_folder_dto_1 = require("./dto/scan-folder.dto");
const confirm_disk_import_dto_1 = require("./dto/confirm-disk-import.dto");
const update_media_profiles_dto_1 = require("./dto/update-media-profiles.dto");
const bulk_update_media_dto_1 = require("./dto/bulk-update-media.dto");
const calendar_query_dto_1 = require("./dto/calendar-query.dto");
const history_query_dto_1 = require("./dto/history-query.dto");
const patch_monitored_dto_1 = require("./dto/patch-monitored.dto");
const update_path_dto_1 = require("./dto/update-path.dto");
const link_torrent_dto_1 = require("./dto/link-torrent.dto");
const suitarr_qualities_1 = require("../../common/constants/suitarr-qualities");
const jwt_or_api_key_guard_1 = require("../auth/guards/jwt-or-api-key.guard");
const policies_guard_1 = require("../auth/casl/policies.guard");
const check_policies_decorator_1 = require("../auth/casl/check-policies.decorator");
const actions_enum_1 = require("../auth/casl/actions.enum");
const media_entity_1 = require("./entities/media.entity");
let MediaController = class MediaController {
    mediaService;
    movieDownload;
    episodeDownload;
    diskImport;
    constructor(mediaService, movieDownload, episodeDownload, diskImport) {
        this.mediaService = mediaService;
        this.movieDownload = movieDownload;
        this.episodeDownload = episodeDownload;
        this.diskImport = diskImport;
    }
    importFromTmdb(dto) {
        return this.mediaService.importFromTmdb(dto);
    }
    diskScan(dto) {
        return this.diskImport.scanFolder(dto.folderPath);
    }
    diskConfirm(dto) {
        return this.diskImport.confirmImport(dto.imports);
    }
    create(dto) {
        return this.mediaService.create(dto);
    }
    findAll(query) {
        return this.mediaService.findAll(query);
    }
    suitarrQualities() {
        return suitarr_qualities_1.SUITARR_QUALITIES;
    }
    calendar(query) {
        return this.mediaService.getCalendar(query);
    }
    history(query) {
        return this.mediaService.getHistory(query);
    }
    deleteHistory(id) {
        return this.mediaService.deleteHistoryEntry(id);
    }
    linkTorrent(dto) {
        return this.mediaService.linkTorrentToMedia(dto.mediaId, dto.sourceTitle, dto.clientId);
    }
    retryImport(id) {
        return this.mediaService.retryImport(id);
    }
    bulkUpdate(dto) {
        return this.mediaService.bulkUpdate(dto);
    }
    renameFiles(id) {
        return this.mediaService.renameFiles(id);
    }
    movieReleases(id, customQuery) {
        return this.movieDownload.searchMovieReleases(id, customQuery);
    }
    grabMovie(id, dto) {
        return this.movieDownload.grabMovie(id, dto ?? {});
    }
    upgradeReleases(id, customQuery) {
        return this.movieDownload.searchUpgradeReleases(id, customQuery);
    }
    grabUpgrade(id, dto) {
        return this.movieDownload.grabUpgrade(id, dto ?? {});
    }
    seasonReleases(id, seasonId, customQuery) {
        return this.episodeDownload.searchSeasonReleases(id, seasonId, customQuery);
    }
    grabSeason(id, seasonId, dto) {
        return this.episodeDownload.grabSeason(id, seasonId, dto ?? {});
    }
    episodeReleases(id, episodeId, customQuery) {
        return this.episodeDownload.searchEpisodeReleases(id, episodeId, customQuery);
    }
    grabEpisode(id, episodeId, dto) {
        return this.episodeDownload.grabEpisode(id, episodeId, dto ?? {});
    }
    deleteFile(id, fileId, deleteOnDisk) {
        return this.mediaService.deleteMediaFile(id, fileId, deleteOnDisk === 'true');
    }
    updatePath(id, dto) {
        return this.mediaService.updatePath(id, dto.path);
    }
    updateProfiles(id, dto) {
        return this.mediaService.updateProfiles(id, dto);
    }
    refreshMetadata(id) {
        return this.mediaService.refreshMetadata(id);
    }
    findOne(id) {
        return this.mediaService.findOne(id);
    }
    update(id, dto) {
        return this.mediaService.update(id, dto);
    }
    remove(id) {
        return this.mediaService.remove(id);
    }
    patchSeason(seasonId, dto) {
        return this.mediaService.updateSeasonMonitored(seasonId, dto.monitored);
    }
    patchEpisode(episodeId, dto) {
        return this.mediaService.updateEpisodeMonitored(episodeId, dto.monitored);
    }
};
exports.MediaController = MediaController;
__decorate([
    (0, common_1.Post)('import/tmdb'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Create, media_entity_1.Media)),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [import_tmdb_dto_1.ImportTmdbDto]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "importFromTmdb", null);
__decorate([
    (0, common_1.Post)('import/disk/scan'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Create, media_entity_1.Media)),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [scan_folder_dto_1.ScanFolderDto]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "diskScan", null);
__decorate([
    (0, common_1.Post)('import/disk/confirm'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Create, media_entity_1.Media)),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [confirm_disk_import_dto_1.ConfirmDiskImportDto]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "diskConfirm", null);
__decorate([
    (0, common_1.Post)(),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Create, media_entity_1.Media)),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [create_media_dto_1.CreateMediaDto]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, media_entity_1.Media)),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [search_media_dto_1.SearchMediaDto]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)('qualities'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, media_entity_1.Media)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "suitarrQualities", null);
__decorate([
    (0, common_1.Get)('calendar'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, media_entity_1.Media)),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [calendar_query_dto_1.CalendarQueryDto]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "calendar", null);
__decorate([
    (0, common_1.Get)('history'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, media_entity_1.Media)),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [history_query_dto_1.HistoryQueryDto]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "history", null);
__decorate([
    (0, common_1.Delete)('history/:historyId'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Delete, media_entity_1.Media)),
    __param(0, (0, common_1.Param)('historyId', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "deleteHistory", null);
__decorate([
    (0, common_1.Post)('history/link'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Manage, media_entity_1.Media)),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [link_torrent_dto_1.LinkTorrentDto]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "linkTorrent", null);
__decorate([
    (0, common_1.Post)('history/:historyId/retry'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Manage, media_entity_1.Media)),
    __param(0, (0, common_1.Param)('historyId', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "retryImport", null);
__decorate([
    (0, common_1.Patch)('bulk'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Update, media_entity_1.Media)),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [bulk_update_media_dto_1.BulkUpdateMediaDto]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "bulkUpdate", null);
__decorate([
    (0, common_1.Post)(':id/rename'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Update, media_entity_1.Media)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "renameFiles", null);
__decorate([
    (0, common_1.Get)(':id/releases'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, media_entity_1.Media)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, common_1.Query)('q')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, String]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "movieReleases", null);
__decorate([
    (0, common_1.Post)(':id/grab'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Grab, media_entity_1.Media)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, grab_movie_dto_1.GrabMovieDto]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "grabMovie", null);
__decorate([
    (0, common_1.Get)(':id/upgrade-releases'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, media_entity_1.Media)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, common_1.Query)('q')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, String]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "upgradeReleases", null);
__decorate([
    (0, common_1.Post)(':id/upgrade'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Grab, media_entity_1.Media)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, grab_movie_dto_1.GrabMovieDto]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "grabUpgrade", null);
__decorate([
    (0, common_1.Get)(':id/seasons/:seasonId/releases'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, media_entity_1.Media)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, common_1.Param)('seasonId', common_1.ParseIntPipe)),
    __param(2, (0, common_1.Query)('q')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, Number, String]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "seasonReleases", null);
__decorate([
    (0, common_1.Post)(':id/seasons/:seasonId/grab'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Grab, media_entity_1.Media)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, common_1.Param)('seasonId', common_1.ParseIntPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, Number, grab_movie_dto_1.GrabMovieDto]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "grabSeason", null);
__decorate([
    (0, common_1.Get)(':id/episodes/:episodeId/releases'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, media_entity_1.Media)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, common_1.Param)('episodeId', common_1.ParseIntPipe)),
    __param(2, (0, common_1.Query)('q')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, Number, String]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "episodeReleases", null);
__decorate([
    (0, common_1.Post)(':id/episodes/:episodeId/grab'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Grab, media_entity_1.Media)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, common_1.Param)('episodeId', common_1.ParseIntPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, Number, grab_movie_dto_1.GrabMovieDto]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "grabEpisode", null);
__decorate([
    (0, common_1.Delete)(':id/files/:fileId'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Delete, media_entity_1.Media)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, common_1.Param)('fileId', common_1.ParseIntPipe)),
    __param(2, (0, common_1.Query)('deleteOnDisk')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, Number, String]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "deleteFile", null);
__decorate([
    (0, common_1.Patch)(':id/root-folder'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Update, media_entity_1.Media)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, update_path_dto_1.UpdatePathDto]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "updatePath", null);
__decorate([
    (0, common_1.Patch)(':id/profiles'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Grab, media_entity_1.Media) ||
        ability.can(actions_enum_1.Action.Update, media_entity_1.Media)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, update_media_profiles_dto_1.UpdateMediaProfilesDto]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "updateProfiles", null);
__decorate([
    (0, common_1.Post)(':id/refresh'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Update, media_entity_1.Media)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "refreshMetadata", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, media_entity_1.Media)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "findOne", null);
__decorate([
    (0, common_1.Put)(':id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Update, media_entity_1.Media)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, update_media_dto_1.UpdateMediaDto]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Delete, media_entity_1.Media)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "remove", null);
__decorate([
    (0, common_1.Patch)('seasons/:seasonId'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Update, media_entity_1.Media)),
    __param(0, (0, common_1.Param)('seasonId', common_1.ParseIntPipe)),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, patch_monitored_dto_1.PatchMonitoredDto]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "patchSeason", null);
__decorate([
    (0, common_1.Patch)('episodes/:episodeId'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Update, media_entity_1.Media)),
    __param(0, (0, common_1.Param)('episodeId', common_1.ParseIntPipe)),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, patch_monitored_dto_1.PatchMonitoredDto]),
    __metadata("design:returntype", void 0)
], MediaController.prototype, "patchEpisode", null);
exports.MediaController = MediaController = __decorate([
    (0, common_1.Controller)('media'),
    (0, common_1.UseGuards)(jwt_or_api_key_guard_1.JwtOrApiKeyGuard, policies_guard_1.PoliciesGuard),
    __metadata("design:paramtypes", [media_service_1.MediaService,
        movie_download_service_1.MovieDownloadService,
        episode_download_service_1.EpisodeDownloadService,
        disk_import_service_1.DiskImportService])
], MediaController);
//# sourceMappingURL=media.controller.js.map