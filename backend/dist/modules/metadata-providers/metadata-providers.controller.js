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
exports.MetadataProvidersController = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const tmdb_provider_1 = require("./providers/tmdb.provider");
const media_entity_1 = require("../media/entities/media.entity");
const jwt_or_api_key_guard_1 = require("../auth/guards/jwt-or-api-key.guard");
let MetadataProvidersController = class MetadataProvidersController {
    tmdb;
    mediaRepo;
    constructor(tmdb, mediaRepo) {
        this.tmdb = tmdb;
        this.mediaRepo = mediaRepo;
    }
    async searchMovie(q, year) {
        const query = q?.trim();
        if (!query)
            return [];
        const results = await this.tmdb.searchMovie(query, year ? +year : undefined);
        return this.enrichWithExisting(results, 'movie');
    }
    async searchTv(q, year) {
        const query = q?.trim();
        if (!query)
            return [];
        const results = await this.tmdb.searchTvShow(query, year ? +year : undefined);
        return this.enrichWithExisting(results, 'series');
    }
    async trendingMovies() {
        const results = await this.tmdb.getTrendingMovies();
        return this.enrichWithExisting(results, 'movie');
    }
    async popularMovies() {
        const results = await this.tmdb.getPopularMovies();
        return this.enrichWithExisting(results, 'movie');
    }
    async upcomingMovies() {
        const results = await this.tmdb.getUpcomingMovies();
        return this.enrichWithExisting(results, 'movie');
    }
    async trendingTv() {
        const results = await this.tmdb.getTrendingTvShows();
        return this.enrichWithExisting(results, 'series');
    }
    async popularTv() {
        const results = await this.tmdb.getPopularTvShows();
        return this.enrichWithExisting(results, 'series');
    }
    async upcomingTv() {
        const results = await this.tmdb.getUpcomingTvShows();
        return this.enrichWithExisting(results, 'series');
    }
    getMovieDetails(tmdbId) {
        return this.tmdb.getMovieDetails(tmdbId);
    }
    getTvDetails(tmdbId) {
        return this.tmdb.getTvShowDetails(tmdbId);
    }
    getTvSeasons(tmdbId) {
        return this.tmdb.getTvShowSeasons(tmdbId);
    }
    async enrichWithExisting(results, type) {
        if (!results.length)
            return results;
        const tmdbIds = results.map((r) => r.tmdbId);
        const existing = await this.mediaRepo.find({
            where: { tmdbId: (0, typeorm_2.In)(tmdbIds), type: type },
            select: ['id', 'tmdbId', 'type'],
        });
        const map = new Map(existing.map((m) => [m.tmdbId, { id: m.id, type: m.type }]));
        return results.map((r) => {
            const match = map.get(r.tmdbId);
            return {
                ...r,
                existingMediaId: match?.id ?? null,
                existingMediaType: match?.type ?? null,
            };
        });
    }
};
exports.MetadataProvidersController = MetadataProvidersController;
__decorate([
    (0, common_1.Get)('search/movie'),
    __param(0, (0, common_1.Query)('q')),
    __param(1, (0, common_1.Query)('year')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], MetadataProvidersController.prototype, "searchMovie", null);
__decorate([
    (0, common_1.Get)('search/tv'),
    __param(0, (0, common_1.Query)('q')),
    __param(1, (0, common_1.Query)('year')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], MetadataProvidersController.prototype, "searchTv", null);
__decorate([
    (0, common_1.Get)('trending/movie'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], MetadataProvidersController.prototype, "trendingMovies", null);
__decorate([
    (0, common_1.Get)('popular/movie'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], MetadataProvidersController.prototype, "popularMovies", null);
__decorate([
    (0, common_1.Get)('upcoming/movie'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], MetadataProvidersController.prototype, "upcomingMovies", null);
__decorate([
    (0, common_1.Get)('trending/tv'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], MetadataProvidersController.prototype, "trendingTv", null);
__decorate([
    (0, common_1.Get)('popular/tv'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], MetadataProvidersController.prototype, "popularTv", null);
__decorate([
    (0, common_1.Get)('upcoming/tv'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], MetadataProvidersController.prototype, "upcomingTv", null);
__decorate([
    (0, common_1.Get)('movie/:tmdbId'),
    __param(0, (0, common_1.Param)('tmdbId', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], MetadataProvidersController.prototype, "getMovieDetails", null);
__decorate([
    (0, common_1.Get)('tv/:tmdbId'),
    __param(0, (0, common_1.Param)('tmdbId', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], MetadataProvidersController.prototype, "getTvDetails", null);
__decorate([
    (0, common_1.Get)('tv/:tmdbId/seasons'),
    __param(0, (0, common_1.Param)('tmdbId', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], MetadataProvidersController.prototype, "getTvSeasons", null);
exports.MetadataProvidersController = MetadataProvidersController = __decorate([
    (0, common_1.Controller)('metadata'),
    (0, common_1.UseGuards)(jwt_or_api_key_guard_1.JwtOrApiKeyGuard),
    __param(1, (0, typeorm_1.InjectRepository)(media_entity_1.Media)),
    __metadata("design:paramtypes", [tmdb_provider_1.TmdbProvider,
        typeorm_2.Repository])
], MetadataProvidersController);
//# sourceMappingURL=metadata-providers.controller.js.map