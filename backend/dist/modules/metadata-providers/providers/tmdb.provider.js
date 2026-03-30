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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var TmdbProvider_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TmdbProvider = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const axios_1 = __importDefault(require("axios"));
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
let TmdbProvider = TmdbProvider_1 = class TmdbProvider {
    config;
    name = 'tmdb';
    client;
    logger = new common_1.Logger(TmdbProvider_1.name);
    constructor(config) {
        this.config = config;
        this.client = axios_1.default.create({
            baseURL: 'https://api.themoviedb.org/3',
            params: { api_key: this.config.get('TMDB_API_KEY', '') },
            timeout: 10000,
        });
    }
    async searchMovie(query, year) {
        const params = { query, language: 'fr-FR' };
        if (year)
            params.year = year;
        const { data } = await this.client.get('/search/movie', { params });
        return data.results.map((r) => this.mapMovieResult(r));
    }
    async searchTvShow(query, year) {
        const params = { query, language: 'fr-FR' };
        if (year)
            params.first_air_date_year = year;
        const { data } = await this.client.get('/search/tv', { params });
        return data.results.map((r) => this.mapTvResult(r));
    }
    async getMovieDetails(tmdbId) {
        const { data } = await this.client.get(`/movie/${tmdbId}`, {
            params: {
                language: 'fr-FR',
                append_to_response: 'external_ids,images,release_dates',
            },
        });
        const dates = this.extractReleaseDates(data.release_dates?.results ?? []);
        return {
            tmdbId: data.id,
            title: data.title,
            originalTitle: data.original_title,
            overview: data.overview,
            year: data.release_date ? parseInt(data.release_date) : null,
            posterUrl: data.poster_path ? `${TMDB_IMAGE_BASE}/w500${data.poster_path}` : null,
            fanartUrl: data.backdrop_path ? `${TMDB_IMAGE_BASE}/original${data.backdrop_path}` : null,
            rating: data.vote_average,
            genres: data.genres?.map((g) => g.name) ?? [],
            mediaType: 'movie',
            imdbId: data.external_ids?.imdb_id ?? data.imdb_id ?? null,
            runtime: data.runtime,
            releaseDate: data.release_date,
            inCinemas: dates.inCinemas,
            digitalRelease: dates.digitalRelease,
            physicalRelease: dates.physicalRelease,
            status: data.status?.toLowerCase() ?? 'unknown',
            budget: data.budget || null,
            revenue: data.revenue || null,
            originalLanguage: data.original_language ?? null,
            productionCountries: (data.production_countries ?? []).map((c) => c.name),
            productionCompanies: (data.production_companies ?? []).map((c) => c.name),
            voteCount: data.vote_count ?? null,
            popularity: data.popularity ?? null,
        };
    }
    async getTvShowDetails(tmdbId) {
        const { data } = await this.client.get(`/tv/${tmdbId}`, {
            params: { language: 'fr-FR', append_to_response: 'external_ids,images' },
        });
        return {
            tmdbId: data.id,
            title: data.name,
            originalTitle: data.original_name,
            overview: data.overview,
            year: data.first_air_date ? parseInt(data.first_air_date) : null,
            posterUrl: data.poster_path ? `${TMDB_IMAGE_BASE}/w500${data.poster_path}` : null,
            fanartUrl: data.backdrop_path ? `${TMDB_IMAGE_BASE}/original${data.backdrop_path}` : null,
            rating: data.vote_average,
            genres: data.genres?.map((g) => g.name) ?? [],
            mediaType: 'series',
            imdbId: data.external_ids?.imdb_id ?? null,
            runtime: data.episode_run_time?.[0] ?? null,
            releaseDate: data.first_air_date,
            inCinemas: null,
            digitalRelease: null,
            physicalRelease: null,
            status: this.mapTvStatus(data.status),
            budget: null,
            revenue: null,
            originalLanguage: data.original_language ?? null,
            productionCountries: (data.origin_country ?? []),
            productionCompanies: [
                ...((data.networks ?? []).map((n) => n.name)),
                ...((data.production_companies ?? []).map((c) => c.name)),
            ],
            voteCount: data.vote_count ?? null,
            popularity: data.popularity ?? null,
        };
    }
    async getTvSeasonStubs(tmdbId) {
        const { data: show } = await this.client.get(`/tv/${tmdbId}`, {
            params: { language: 'fr-FR' },
        });
        return (show.seasons ?? [])
            .filter((s) => s.season_number > 0)
            .map((s) => ({
            seasonNumber: s.season_number,
            episodeCount: s.episode_count ?? 0,
        }));
    }
    async getTvShowSeasons(tmdbId) {
        const { data: show } = await this.client.get(`/tv/${tmdbId}`, {
            params: { language: 'fr-FR' },
        });
        const seasons = [];
        for (const s of show.seasons ?? []) {
            if (s.season_number === 0)
                continue;
            try {
                const { data: season } = await this.client.get(`/tv/${tmdbId}/season/${s.season_number}`, { params: { language: 'fr-FR' } });
                seasons.push({
                    seasonNumber: season.season_number,
                    episodeCount: season.episodes?.length ?? 0,
                    overview: season.overview || null,
                    airDate: season.air_date || null,
                    episodes: (season.episodes ?? []).map((e) => ({
                        episodeNumber: e.episode_number,
                        title: e.name,
                        overview: e.overview || null,
                        airDate: e.air_date || null,
                    })),
                });
            }
            catch (err) {
                this.logger.warn(`Failed to fetch season ${s.season_number} for TV ${tmdbId}`);
            }
        }
        return seasons;
    }
    mapMovieResult(r) {
        return {
            tmdbId: r.id,
            title: r.title,
            originalTitle: r.original_title,
            overview: r.overview,
            year: r.release_date ? parseInt(r.release_date) : null,
            posterUrl: r.poster_path ? `${TMDB_IMAGE_BASE}/w500${r.poster_path}` : null,
            rating: r.vote_average,
            genres: [],
            mediaType: 'movie',
        };
    }
    mapTvResult(r) {
        return {
            tmdbId: r.id,
            title: r.name,
            originalTitle: r.original_name,
            overview: r.overview,
            year: r.first_air_date ? parseInt(r.first_air_date) : null,
            posterUrl: r.poster_path ? `${TMDB_IMAGE_BASE}/w500${r.poster_path}` : null,
            rating: r.vote_average,
            genres: [],
            mediaType: 'series',
        };
    }
    extractReleaseDates(results) {
        const dates = {};
        const priority = ['FR', 'US'];
        const sorted = [...results].sort((a, b) => {
            const ai = priority.indexOf(a.iso_3166_1);
            const bi = priority.indexOf(b.iso_3166_1);
            return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        });
        for (const country of sorted) {
            for (const rd of country.release_dates) {
                if (!rd.release_date)
                    continue;
                const d = rd.release_date.slice(0, 10);
                if (!dates[rd.type] || d < dates[rd.type]) {
                    dates[rd.type] = d;
                }
            }
        }
        return {
            inCinemas: dates[3] ?? dates[2] ?? dates[1] ?? null,
            digitalRelease: dates[4] ?? null,
            physicalRelease: dates[5] ?? null,
        };
    }
    mapTvStatus(status) {
        const map = {
            'Returning Series': 'continuing',
            Ended: 'ended',
            Canceled: 'ended',
            'In Production': 'announced',
            Planned: 'tba',
        };
        return map[status] ?? 'unknown';
    }
};
exports.TmdbProvider = TmdbProvider;
exports.TmdbProvider = TmdbProvider = TmdbProvider_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], TmdbProvider);
//# sourceMappingURL=tmdb.provider.js.map