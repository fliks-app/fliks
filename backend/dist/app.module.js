"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const typeorm_1 = require("@nestjs/typeorm");
const auth_module_1 = require("./modules/auth/auth.module");
const users_module_1 = require("./modules/users/users.module");
const media_module_1 = require("./modules/media/media.module");
const profiles_module_1 = require("./modules/profiles/profiles.module");
const tags_module_1 = require("./modules/tags/tags.module");
const metadata_providers_module_1 = require("./modules/metadata-providers/metadata-providers.module");
const indexers_module_1 = require("./modules/indexers/indexers.module");
const download_clients_module_1 = require("./modules/download-clients/download-clients.module");
const requests_module_1 = require("./modules/requests/requests.module");
const scheduler_module_1 = require("./modules/scheduler/scheduler.module");
const root_folders_module_1 = require("./modules/root-folders/root-folders.module");
const blocklist_module_1 = require("./modules/blocklist/blocklist.module");
const notifications_module_1 = require("./modules/notifications/notifications.module");
const settings_module_1 = require("./modules/settings/settings.module");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({ isGlobal: true }),
            typeorm_1.TypeOrmModule.forRootAsync({
                inject: [config_1.ConfigService],
                useFactory: (config) => ({
                    type: 'postgres',
                    host: config.get('DB_HOST', 'localhost'),
                    port: config.get('DB_PORT', 5432),
                    username: config.get('DB_USERNAME', 'suitarr'),
                    password: config.get('DB_PASSWORD', 'suitarr'),
                    database: config.get('DB_NAME', 'suitarr'),
                    autoLoadEntities: true,
                    synchronize: true,
                    extra: { max: 20 },
                }),
            }),
            auth_module_1.AuthModule,
            users_module_1.UsersModule,
            media_module_1.MediaModule,
            profiles_module_1.ProfilesModule,
            tags_module_1.TagsModule,
            metadata_providers_module_1.MetadataProvidersModule,
            indexers_module_1.IndexersModule,
            download_clients_module_1.DownloadClientsModule,
            requests_module_1.RequestsModule,
            scheduler_module_1.SuitarrSchedulerModule,
            root_folders_module_1.RootFoldersModule,
            blocklist_module_1.BlocklistModule,
            notifications_module_1.NotificationsModule,
            settings_module_1.SettingsModule,
        ],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map