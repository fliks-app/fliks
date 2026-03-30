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
exports.MediaFile = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../../common/entities/base.entity");
const media_entity_1 = require("./media.entity");
let MediaFile = class MediaFile extends base_entity_1.BaseEntity {
    media;
    mediaId;
    episodeId;
    relativePath;
    size;
    quality;
    language;
};
exports.MediaFile = MediaFile;
__decorate([
    (0, typeorm_1.ManyToOne)(() => media_entity_1.Media, (media) => media.files, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'mediaId' }),
    __metadata("design:type", media_entity_1.Media)
], MediaFile.prototype, "media", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", Number)
], MediaFile.prototype, "mediaId", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", Number)
], MediaFile.prototype, "episodeId", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], MediaFile.prototype, "relativePath", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'bigint' }),
    __metadata("design:type", Number)
], MediaFile.prototype, "size", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], MediaFile.prototype, "quality", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], MediaFile.prototype, "language", void 0);
exports.MediaFile = MediaFile = __decorate([
    (0, typeorm_1.Entity)('media_files')
], MediaFile);
//# sourceMappingURL=media-file.entity.js.map