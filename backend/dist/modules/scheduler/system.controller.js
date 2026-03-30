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
let SystemController = class SystemController {
    dataSource;
    indexerRepo;
    clientRepo;
    rootFolderRepo;
    qbittorrent;
    constructor(dataSource, indexerRepo, clientRepo, rootFolderRepo, qbittorrent) {
        this.dataSource = dataSource;
        this.indexerRepo = indexerRepo;
        this.clientRepo = clientRepo;
        this.rootFolderRepo = rootFolderRepo;
        this.qbittorrent = qbittorrent;
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
        qbittorrent_service_1.QbittorrentService])
], SystemController);
//# sourceMappingURL=system.controller.js.map