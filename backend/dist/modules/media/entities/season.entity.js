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
exports.Season = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../../common/entities/base.entity");
const media_entity_1 = require("./media.entity");
const episode_entity_1 = require("./episode.entity");
let Season = class Season extends base_entity_1.BaseEntity {
    media;
    mediaId;
    seasonNumber;
    monitored;
    episodes;
};
exports.Season = Season;
__decorate([
    (0, typeorm_1.ManyToOne)(() => media_entity_1.Media, (media) => media.seasons, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'mediaId' }),
    __metadata("design:type", media_entity_1.Media)
], Season.prototype, "media", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", Number)
], Season.prototype, "mediaId", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", Number)
], Season.prototype, "seasonNumber", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: true }),
    __metadata("design:type", Boolean)
], Season.prototype, "monitored", void 0);
__decorate([
    (0, typeorm_1.OneToMany)(() => episode_entity_1.Episode, (episode) => episode.season, { cascade: true }),
    __metadata("design:type", Array)
], Season.prototype, "episodes", void 0);
exports.Season = Season = __decorate([
    (0, typeorm_1.Entity)('seasons')
], Season);
//# sourceMappingURL=season.entity.js.map