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
exports.Media = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../../common/entities/base.entity");
const enums_1 = require("../../../common/enums");
const quality_profile_entity_1 = require("../../profiles/entities/quality-profile.entity");
const language_profile_entity_1 = require("../../profiles/entities/language-profile.entity");
const tag_entity_1 = require("../../tags/entities/tag.entity");
const season_entity_1 = require("./season.entity");
const media_file_entity_1 = require("./media-file.entity");
let Media = class Media extends base_entity_1.BaseEntity {
    title;
    originalTitle;
    year;
    type;
    tmdbId;
    imdbId;
    overview;
    status;
    monitored;
    path;
    posterUrl;
    fanartUrl;
    rating;
    genres;
    runtime;
    releaseDate;
    inCinemas;
    digitalRelease;
    physicalRelease;
    minimumAvailability;
    searchVector;
    qualityProfile;
    qualityProfileId;
    languageProfile;
    languageProfileId;
    tags;
    seasons;
    files;
};
exports.Media = Media;
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], Media.prototype, "title", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], Media.prototype, "originalTitle", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", Number)
], Media.prototype, "year", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'enum', enum: enums_1.MediaType }),
    __metadata("design:type", String)
], Media.prototype, "type", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', nullable: true }),
    __metadata("design:type", Number)
], Media.prototype, "tmdbId", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], Media.prototype, "imdbId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", String)
], Media.prototype, "overview", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'enum', enum: enums_1.MediaStatus, default: enums_1.MediaStatus.TBA }),
    __metadata("design:type", String)
], Media.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: true }),
    __metadata("design:type", Boolean)
], Media.prototype, "monitored", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], Media.prototype, "path", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], Media.prototype, "posterUrl", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], Media.prototype, "fanartUrl", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'float', nullable: true }),
    __metadata("design:type", Number)
], Media.prototype, "rating", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'jsonb', nullable: true }),
    __metadata("design:type", Array)
], Media.prototype, "genres", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", Number)
], Media.prototype, "runtime", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'date', nullable: true }),
    __metadata("design:type", String)
], Media.prototype, "releaseDate", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'date', nullable: true }),
    __metadata("design:type", String)
], Media.prototype, "inCinemas", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'date', nullable: true }),
    __metadata("design:type", String)
], Media.prototype, "digitalRelease", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'date', nullable: true }),
    __metadata("design:type", String)
], Media.prototype, "physicalRelease", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', default: enums_1.MinimumAvailability.RELEASED }),
    __metadata("design:type", String)
], Media.prototype, "minimumAvailability", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'tsvector',
        nullable: true,
        select: false,
    }),
    __metadata("design:type", String)
], Media.prototype, "searchVector", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => quality_profile_entity_1.QualityProfile, { nullable: true, eager: true }),
    (0, typeorm_1.JoinColumn)({ name: 'qualityProfileId' }),
    __metadata("design:type", quality_profile_entity_1.QualityProfile)
], Media.prototype, "qualityProfile", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", Number)
], Media.prototype, "qualityProfileId", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => language_profile_entity_1.LanguageProfile, { nullable: true, eager: true }),
    (0, typeorm_1.JoinColumn)({ name: 'languageProfileId' }),
    __metadata("design:type", language_profile_entity_1.LanguageProfile)
], Media.prototype, "languageProfile", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", Number)
], Media.prototype, "languageProfileId", void 0);
__decorate([
    (0, typeorm_1.ManyToMany)(() => tag_entity_1.Tag, { eager: true }),
    (0, typeorm_1.JoinTable)({ name: 'media_tags' }),
    __metadata("design:type", Array)
], Media.prototype, "tags", void 0);
__decorate([
    (0, typeorm_1.OneToMany)(() => season_entity_1.Season, (season) => season.media, { cascade: true }),
    __metadata("design:type", Array)
], Media.prototype, "seasons", void 0);
__decorate([
    (0, typeorm_1.OneToMany)(() => media_file_entity_1.MediaFile, (file) => file.media, { cascade: true }),
    __metadata("design:type", Array)
], Media.prototype, "files", void 0);
exports.Media = Media = __decorate([
    (0, typeorm_1.Entity)('media'),
    (0, typeorm_1.Index)('idx_media_search_vector', { synchronize: false }),
    (0, typeorm_1.Index)('UQ_media_type_tmdbId', ['type', 'tmdbId'], { unique: true })
], Media);
//# sourceMappingURL=media.entity.js.map