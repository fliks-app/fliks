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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SystemController = void 0;
const common_1 = require("@nestjs/common");
const platform_express_1 = require("@nestjs/platform-express");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const fs = __importStar(require("fs"));
const indexer_entity_1 = require("../indexers/entities/indexer.entity");
const download_client_entity_1 = require("../download-clients/entities/download-client.entity");
const root_folder_entity_1 = require("../root-folders/entities/root-folder.entity");
const qbittorrent_service_1 = require("../download-clients/qbittorrent.service");
const jwt_or_api_key_guard_1 = require("../auth/guards/jwt-or-api-key.guard");
const policies_guard_1 = require("../auth/casl/policies.guard");
const check_policies_decorator_1 = require("../auth/casl/check-policies.decorator");
const actions_enum_1 = require("../auth/casl/actions.enum");
const backup_service_1 = require("./backup.service");
const log_buffer_service_1 = require("./log-buffer.service");
const events_service_1 = require("./events.service");
const import_radarr_service_1 = require("./import-radarr.service");
const import_sonarr_service_1 = require("./import-sonarr.service");
const import_api_dto_1 = require("./dto/import-api.dto");
const rxjs_1 = require("rxjs");
let SystemController = class SystemController {
    dataSource;
    indexerRepo;
    clientRepo;
    rootFolderRepo;
    qbittorrent;
    backup;
    logBuffer;
    eventsService;
    importRadarrService;
    importSonarrService;
    constructor(dataSource, indexerRepo, clientRepo, rootFolderRepo, qbittorrent, backup, logBuffer, eventsService, importRadarrService, importSonarrService) {
        this.dataSource = dataSource;
        this.indexerRepo = indexerRepo;
        this.clientRepo = clientRepo;
        this.rootFolderRepo = rootFolderRepo;
        this.qbittorrent = qbittorrent;
        this.backup = backup;
        this.logBuffer = logBuffer;
        this.eventsService = eventsService;
        this.importRadarrService = importRadarrService;
        this.importSonarrService = importSonarrService;
    }
    events() {
        return this.eventsService.getStream();
    }
    async health() {
        const [dbStatus, indexers, clients] = await Promise.all([
            this.checkDatabase(),
            this.checkIndexers(),
            this.checkClients(),
        ]);
        return {
            version: process.env.npm_package_version ?? '0.1.0',
            uptimeSeconds: Math.floor(process.uptime()),
            database: dbStatus,
            indexers,
            downloadClients: clients,
        };
    }
    async checkDatabase() {
        try {
            await this.dataSource.query('SELECT 1');
            return { name: 'PostgreSQL', ok: true };
        }
        catch (e) {
            return { name: 'PostgreSQL', ok: false, message: e.message };
        }
    }
    async checkIndexers() {
        const [enabled, total] = await Promise.all([
            this.indexerRepo.count({ where: { enabled: true } }),
            this.indexerRepo.count(),
        ]);
        return { enabled, total };
    }
    async stats() {
        const [[moviesRow], [seriesRow], [pendingRow], rootFolders] = await Promise.all([
            this.dataSource.query(`SELECT COUNT(*)::int AS count FROM media WHERE type = 'movie'`),
            this.dataSource.query(`SELECT COUNT(*)::int AS count FROM media WHERE type = 'series'`),
            this.dataSource.query(`SELECT COUNT(*)::int AS count FROM requests WHERE status = 'pending'`),
            this.rootFolderRepo.find({ order: { path: 'ASC' } }),
        ]);
        const diskSpace = rootFolders.map((f) => {
            try {
                const stat = fs.statfsSync(f.path);
                return {
                    path: f.path,
                    label: f.label ?? null,
                    freeSpace: stat.bfree * stat.bsize,
                    totalSpace: stat.blocks * stat.bsize,
                };
            }
            catch {
                return { path: f.path, label: f.label ?? null, freeSpace: -1, totalSpace: -1 };
            }
        });
        return {
            movies: moviesRow.count,
            series: seriesRow.count,
            pendingRequests: pendingRow.count,
            diskSpace,
        };
    }
    createBackup() {
        return this.backup.createBackup();
    }
    listBackups() {
        return this.backup.listBackups();
    }
    restore(body) {
        return this.backup.restore(body.filename);
    }
    downloadBackup(name, res) {
        const filePath = this.backup.getBackupPath(name);
        res.download(filePath, name);
    }
    getLogs(level, q, limit) {
        return this.logBuffer.getEntries({
            level: level || undefined,
            q: q || undefined,
            limit: limit ? parseInt(limit, 10) : 200,
        });
    }
    importRadarr(file) {
        if (!file?.buffer?.length) {
            throw new common_1.BadRequestException('No file uploaded');
        }
        return this.importRadarrService.importFromDump(file.buffer);
    }
    importSonarr(file) {
        if (!file?.buffer?.length) {
            throw new common_1.BadRequestException('No file uploaded');
        }
        return this.importSonarrService.importFromDump(file.buffer);
    }
    importRadarrApi(dto) {
        return this.importRadarrService.importFromApi(dto.url, dto.apiKey);
    }
    importSonarrApi(dto) {
        return this.importSonarrService.importFromApi(dto.url, dto.apiKey);
    }
    async checkClients() {
        const clients = await this.clientRepo.find({ where: { enabled: true } });
        return Promise.all(clients.map(async (c) => {
            const result = await this.qbittorrent.testConnection(c.settings);
            return { name: c.name, ok: result.ok, message: result.ok ? undefined : result.message };
        }));
    }
};
exports.SystemController = SystemController;
__decorate([
    (0, common_1.Sse)('events'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", rxjs_1.Observable)
], SystemController.prototype, "events", null);
__decorate([
    (0, common_1.Get)('health'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, 'Settings')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], SystemController.prototype, "health", null);
__decorate([
    (0, common_1.Get)('stats'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, 'Settings')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], SystemController.prototype, "stats", null);
__decorate([
    (0, common_1.Post)('backup'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Create, 'Settings')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], SystemController.prototype, "createBackup", null);
__decorate([
    (0, common_1.Get)('backups'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, 'Settings')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], SystemController.prototype, "listBackups", null);
__decorate([
    (0, common_1.Post)('restore'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Create, 'Settings')),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], SystemController.prototype, "restore", null);
__decorate([
    (0, common_1.Get)('backups/:name'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, 'Settings')),
    __param(0, (0, common_1.Param)('name')),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], SystemController.prototype, "downloadBackup", null);
__decorate([
    (0, common_1.Get)('logs'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, 'Settings')),
    __param(0, (0, common_1.Query)('level')),
    __param(1, (0, common_1.Query)('q')),
    __param(2, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", void 0)
], SystemController.prototype, "getLogs", null);
__decorate([
    (0, common_1.Post)('import-radarr'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Create, 'Settings')),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('file')),
    __param(0, (0, common_1.UploadedFile)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], SystemController.prototype, "importRadarr", null);
__decorate([
    (0, common_1.Post)('import-sonarr'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Create, 'Settings')),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('file')),
    __param(0, (0, common_1.UploadedFile)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], SystemController.prototype, "importSonarr", null);
__decorate([
    (0, common_1.Post)('import-radarr-api'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Create, 'Settings')),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [import_api_dto_1.ImportApiDto]),
    __metadata("design:returntype", Promise)
], SystemController.prototype, "importRadarrApi", null);
__decorate([
    (0, common_1.Post)('import-sonarr-api'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Create, 'Settings')),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [import_api_dto_1.ImportApiDto]),
    __metadata("design:returntype", Promise)
], SystemController.prototype, "importSonarrApi", null);
exports.SystemController = SystemController = __decorate([
    (0, common_1.Controller)('system'),
    (0, common_1.UseGuards)(jwt_or_api_key_guard_1.JwtOrApiKeyGuard, policies_guard_1.PoliciesGuard),
    __param(1, (0, typeorm_1.InjectRepository)(indexer_entity_1.Indexer)),
    __param(2, (0, typeorm_1.InjectRepository)(download_client_entity_1.DownloadClient)),
    __param(3, (0, typeorm_1.InjectRepository)(root_folder_entity_1.RootFolder)),
    __metadata("design:paramtypes", [typeorm_2.DataSource,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        qbittorrent_service_1.QbittorrentService,
        backup_service_1.BackupService,
        log_buffer_service_1.LogBufferService,
        events_service_1.EventsService,
        import_radarr_service_1.ImportRadarrService,
        import_sonarr_service_1.ImportSonarrService])
], SystemController);
//# sourceMappingURL=system.controller.js.map