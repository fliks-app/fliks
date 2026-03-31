"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MediaModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const media_entity_1 = require("./entities/media.entity");
const season_entity_1 = require("./entities/season.entity");
const episode_entity_1 = require("./entities/episode.entity");
const media_file_entity_1 = require("./entities/media-file.entity");
const download_history_entity_1 = require("./entities/download-history.entity");
const tag_entity_1 = require("../tags/entities/tag.entity");
const media_service_1 = require("./media.service");
const media_controller_1 = require("./media.controller");
const auth_module_1 = require("../auth/auth.module");
const metadata_providers_module_1 = require("../metadata-providers/metadata-providers.module");
const profiles_module_1 = require("../profiles/profiles.module");
const indexers_module_1 = require("../indexers/indexers.module");
const download_clients_module_1 = require("../download-clients/download-clients.module");
const blocklist_module_1 = require("../blocklist/blocklist.module");
const notifications_module_1 = require("../notifications/notifications.module");
const movie_download_service_1 = require("./movie-download.service");
const episode_download_service_1 = require("./episode-download.service");
const disk_import_service_1 = require("./disk-import.service");
const naming_service_1 = require("../scheduler/naming.service");
const root_folder_entity_1 = require("../root-folders/entities/root-folder.entity");
let MediaModule = class MediaModule {
};
exports.MediaModule = MediaModule;
exports.MediaModule = MediaModule = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([
                media_entity_1.Media,
                season_entity_1.Season,
                episode_entity_1.Episode,
                media_file_entity_1.MediaFile,
                download_history_entity_1.DownloadHistory,
                tag_entity_1.Tag,
                root_folder_entity_1.RootFolder,
            ]),
            auth_module_1.AuthModule,
            metadata_providers_module_1.MetadataProvidersModule,
            profiles_module_1.ProfilesModule,
            indexers_module_1.IndexersModule,
            download_clients_module_1.DownloadClientsModule,
            blocklist_module_1.BlocklistModule,
            notifications_module_1.NotificationsModule,
        ],
        controllers: [media_controller_1.MediaController],
        providers: [media_service_1.MediaService, movie_download_service_1.MovieDownloadService, episode_download_service_1.EpisodeDownloadService, disk_import_service_1.DiskImportService, naming_service_1.NamingService],
        exports: [media_service_1.MediaService],
    })
], MediaModule);
//# sourceMappingURL=media.module.js.map