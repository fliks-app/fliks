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
exports.DownloadClientsController = void 0;
const common_1 = require("@nestjs/common");
const download_clients_service_1 = require("./download-clients.service");
const create_download_client_dto_1 = require("./dto/create-download-client.dto");
const update_download_client_dto_1 = require("./dto/update-download-client.dto");
const test_download_client_dto_1 = require("./dto/test-download-client.dto");
const jwt_or_api_key_guard_1 = require("../auth/guards/jwt-or-api-key.guard");
const policies_guard_1 = require("../auth/casl/policies.guard");
const check_policies_decorator_1 = require("../auth/casl/check-policies.decorator");
const actions_enum_1 = require("../auth/casl/actions.enum");
const download_client_entity_1 = require("./entities/download-client.entity");
let DownloadClientsController = class DownloadClientsController {
    service;
    constructor(service) {
        this.service = service;
    }
    testConnection(dto) {
        return this.service.testConnection(dto);
    }
    create(dto) {
        return this.service.create(dto);
    }
    findAll() {
        return this.service.findAll();
    }
    queue() {
        return this.service.getQueue();
    }
    removeTorrent(hash, clientId, deleteFiles) {
        return this.service.removeTorrent(clientId, hash, deleteFiles === 'true');
    }
    findOne(id) {
        return this.service.findOne(id);
    }
    update(id, dto) {
        return this.service.update(id, dto);
    }
    remove(id) {
        return this.service.remove(id);
    }
};
exports.DownloadClientsController = DownloadClientsController;
__decorate([
    (0, common_1.Post)('test-connection'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Create, download_client_entity_1.DownloadClient)),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [test_download_client_dto_1.TestDownloadClientDto]),
    __metadata("design:returntype", void 0)
], DownloadClientsController.prototype, "testConnection", null);
__decorate([
    (0, common_1.Post)(),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Create, download_client_entity_1.DownloadClient)),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [create_download_client_dto_1.CreateDownloadClientDto]),
    __metadata("design:returntype", void 0)
], DownloadClientsController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, download_client_entity_1.DownloadClient)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], DownloadClientsController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)('queue'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, download_client_entity_1.DownloadClient)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], DownloadClientsController.prototype, "queue", null);
__decorate([
    (0, common_1.Delete)('queue/:hash'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Delete, download_client_entity_1.DownloadClient)),
    __param(0, (0, common_1.Param)('hash')),
    __param(1, (0, common_1.Query)('clientId', common_1.ParseIntPipe)),
    __param(2, (0, common_1.Query)('deleteFiles')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number, String]),
    __metadata("design:returntype", void 0)
], DownloadClientsController.prototype, "removeTorrent", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, download_client_entity_1.DownloadClient)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], DownloadClientsController.prototype, "findOne", null);
__decorate([
    (0, common_1.Put)(':id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Update, download_client_entity_1.DownloadClient)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, update_download_client_dto_1.UpdateDownloadClientDto]),
    __metadata("design:returntype", void 0)
], DownloadClientsController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Delete, download_client_entity_1.DownloadClient)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], DownloadClientsController.prototype, "remove", null);
exports.DownloadClientsController = DownloadClientsController = __decorate([
    (0, common_1.Controller)('download-clients'),
    (0, common_1.UseGuards)(jwt_or_api_key_guard_1.JwtOrApiKeyGuard, policies_guard_1.PoliciesGuard),
    __metadata("design:paramtypes", [download_clients_service_1.DownloadClientsService])
], DownloadClientsController);
//# sourceMappingURL=download-clients.controller.js.map