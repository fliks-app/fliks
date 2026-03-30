"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DownloadClientsModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const download_client_entity_1 = require("./entities/download-client.entity");
const tag_entity_1 = require("../tags/entities/tag.entity");
const download_history_entity_1 = require("../media/entities/download-history.entity");
const qbittorrent_service_1 = require("./qbittorrent.service");
const download_clients_service_1 = require("./download-clients.service");
const download_clients_controller_1 = require("./download-clients.controller");
const auth_module_1 = require("../auth/auth.module");
let DownloadClientsModule = class DownloadClientsModule {
};
exports.DownloadClientsModule = DownloadClientsModule;
exports.DownloadClientsModule = DownloadClientsModule = __decorate([
    (0, common_1.Module)({
        imports: [typeorm_1.TypeOrmModule.forFeature([download_client_entity_1.DownloadClient, tag_entity_1.Tag, download_history_entity_1.DownloadHistory]), auth_module_1.AuthModule],
        controllers: [download_clients_controller_1.DownloadClientsController],
        providers: [qbittorrent_service_1.QbittorrentService, download_clients_service_1.DownloadClientsService],
        exports: [typeorm_1.TypeOrmModule, qbittorrent_service_1.QbittorrentService],
    })
], DownloadClientsModule);
//# sourceMappingURL=download-clients.module.js.map