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
exports.Episode = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../../common/entities/base.entity");
const season_entity_1 = require("./season.entity");
let Episode = class Episode extends base_entity_1.BaseEntity {
    season;
    seasonId;
    episodeNumber;
    title;
    overview;
    airDate;
    monitored;
    hasFile;
    searchVector;
};
exports.Episode = Episode;
__decorate([
    (0, typeorm_1.ManyToOne)(() => season_entity_1.Season, (season) => season.episodes, {
        onDelete: 'CASCADE',
    }),
    (0, typeorm_1.JoinColumn)({ name: 'seasonId' }),
    __metadata("design:type", season_entity_1.Season)
], Episode.prototype, "season", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", Number)
], Episode.prototype, "seasonId", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", Number)
], Episode.prototype, "episodeNumber", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], Episode.prototype, "title", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", String)
], Episode.prototype, "overview", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'date', nullable: true }),
    __metadata("design:type", String)
], Episode.prototype, "airDate", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: true }),
    __metadata("design:type", Boolean)
], Episode.prototype, "monitored", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: false }),
    __metadata("design:type", Boolean)
], Episode.prototype, "hasFile", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'tsvector',
        nullable: true,
        select: false,
    }),
    __metadata("design:type", String)
], Episode.prototype, "searchVector", void 0);
exports.Episode = Episode = __decorate([
    (0, typeorm_1.Entity)('episodes')
], Episode);
//# sourceMappingURL=episode.entity.js.map