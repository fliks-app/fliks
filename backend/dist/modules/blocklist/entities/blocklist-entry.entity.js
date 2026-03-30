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
exports.BlocklistEntry = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../../common/entities/base.entity");
let BlocklistEntry = class BlocklistEntry extends base_entity_1.BaseEntity {
    sourceTitle;
    indexerId;
    indexerName;
    downloadUrl;
    quality;
    mediaId;
    note;
};
exports.BlocklistEntry = BlocklistEntry;
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], BlocklistEntry.prototype, "sourceTitle", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", Number)
], BlocklistEntry.prototype, "indexerId", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], BlocklistEntry.prototype, "indexerName", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], BlocklistEntry.prototype, "downloadUrl", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], BlocklistEntry.prototype, "quality", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", Number)
], BlocklistEntry.prototype, "mediaId", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], BlocklistEntry.prototype, "note", void 0);
exports.BlocklistEntry = BlocklistEntry = __decorate([
    (0, typeorm_1.Entity)('blocklist')
], BlocklistEntry);
//# sourceMappingURL=blocklist-entry.entity.js.map