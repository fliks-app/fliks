"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SuitarrSchedulerModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const schedule_1 = require("@nestjs/schedule");
const command_entity_1 = require("./entities/command.entity");
const media_entity_1 = require("../media/entities/media.entity");
const media_file_entity_1 = require("../media/entities/media-file.entity");
const download_history_entity_1 = require("../media/entities/download-history.entity");
const season_entity_1 = require("../media/entities/season.entity");
const episode_entity_1 = require("../media/entities/episode.entity");
const indexer_entity_1 = require("../indexers/entities/indexer.entity");
const download_client_entity_1 = require("../download-clients/entities/download-client.entity");
const root_folder_entity_1 = require("../root-folders/entities/root-folder.entity");
const scheduler_service_1 = require("./scheduler.service");
const completion_service_1 = require("./completion.service");
const naming_service_1 = require("./naming.service");
const commands_controller_1 = require("./commands.controller");
const system_controller_1 = require("./system.controller");
const indexers_module_1 = require("../indexers/indexers.module");
const download_clients_module_1 = require("../download-clients/download-clients.module");
const metadata_providers_module_1 = require("../metadata-providers/metadata-providers.module");
const notifications_module_1 = require("../notifications/notifications.module");
const media_module_1 = require("../media/media.module");
const auth_module_1 = require("../auth/auth.module");
let SuitarrSchedulerModule = class SuitarrSchedulerModule {
};
exports.SuitarrSchedulerModule = SuitarrSchedulerModule;
exports.SuitarrSchedulerModule = SuitarrSchedulerModule = __decorate([
    (0, common_1.Module)({
        imports: [
            schedule_1.ScheduleModule.forRoot(),
            typeorm_1.TypeOrmModule.forFeature([
                command_entity_1.Command,
                media_entity_1.Media,
                media_file_entity_1.MediaFile,
                download_history_entity_1.DownloadHistory,
                season_entity_1.Season,
                episode_entity_1.Episode,
                indexer_entity_1.Indexer,
                download_client_entity_1.DownloadClient,
                root_folder_entity_1.RootFolder,
            ]),
            indexers_module_1.IndexersModule,
            download_clients_module_1.DownloadClientsModule,
            metadata_providers_module_1.MetadataProvidersModule,
            notifications_module_1.NotificationsModule,
            media_module_1.MediaModule,
            auth_module_1.AuthModule,
        ],
        controllers: [commands_controller_1.CommandsController, system_controller_1.SystemController],
        providers: [scheduler_service_1.SchedulerService, completion_service_1.CompletionService, naming_service_1.NamingService],
        exports: [scheduler_service_1.SchedulerService, completion_service_1.CompletionService],
    })
], SuitarrSchedulerModule);
//# sourceMappingURL=scheduler.module.js.map