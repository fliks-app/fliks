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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DownloadClient = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../../common/entities/base.entity");
const tag_entity_1 = require("../../tags/entities/tag.entity");
let DownloadClient = class DownloadClient extends base_entity_1.BaseEntity {
    name;
    implementation;
    settings;
    enabled;
    priority;
    tags;
};
exports.DownloadClient = DownloadClient;
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], DownloadClient.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], DownloadClient.prototype, "implementation", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'jsonb', default: {} }),
    __metadata("design:type", Object)
], DownloadClient.prototype, "settings", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: true }),
    __metadata("design:type", Boolean)
], DownloadClient.prototype, "enabled", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: 1 }),
    __metadata("design:type", Number)
], DownloadClient.prototype, "priority", void 0);
__decorate([
    (0, typeorm_1.ManyToMany)(() => tag_entity_1.Tag, { eager: true }),
    (0, typeorm_1.JoinTable)({ name: 'download_client_tags' }),
    __metadata("design:type", Array)
], DownloadClient.prototype, "tags", void 0);
exports.DownloadClient = DownloadClient = __decorate([
    (0, typeorm_1.Entity)('download_clients')
], DownloadClient);
//# sourceMappingURL=download-client.entity.js.map