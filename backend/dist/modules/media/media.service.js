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
var MediaService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MediaService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const media_entity_1 = require("./entities/media.entity");
const media_file_entity_1 = require("./entities/media-file.entity");
const season_entity_1 = require("./entities/season.entity");
const episode_entity_1 = require("./entities/episode.entity");
const download_history_entity_1 = require("./entities/download-history.entity");
const tag_entity_1 = require("../tags/entities/tag.entity");
const tmdb_provider_1 = require("../metadata-providers/providers/tmdb.provider");
const enums_1 = require("../../common/enums");
const profiles_service_1 = require("../profiles/profiles.service");
const root_folder_entity_1 = require("../root-folders/entities/root-folder.entity");
let MediaService = MediaService_1 = class MediaService {
    mediaRepo;
    tagRepo;
    seasonRepo;
    episodeRepo;
    mediaFileRepo;
    historyRepo;
    rootFolderRepo;
    dataSource;
    tmdb;
    config;
    profiles;
    log = new common_1.Logger(MediaService_1.name);
    constructor(mediaRepo, tagRepo, seasonRepo, episodeRepo, mediaFileRepo, historyRepo, rootFolderRepo, dataSource, tmdb, config, profiles) {
        this.mediaRepo = mediaRepo;
        this.tagRepo = tagRepo;
        this.seasonRepo = seasonRepo;
        this.episodeRepo = episodeRepo;
        this.mediaFileRepo = mediaFileRepo;
        this.historyRepo = historyRepo;
        this.rootFolderRepo = rootFolderRepo;
        this.dataSource = dataSource;
        this.tmdb = tmdb;
        this.config = config;
        this.profiles = profiles;
    }
    async importFromTmdb(dto) {
        const key = this.config.get('TMDB_API_KEY', '');
        if (!key?.trim()) {
            throw new common_1.BadRequestException('TMDB API key is not configured');
        }
        const existing = await this.mediaRepo.findOne({
            where: { tmdbId: dto.tmdbId, type: dto.type },
        });
        if (existing) {
            throw new common_1.ConflictException('This title is already in the library');
        }
        const qualityProfileId = await this.profiles.resolveQualityProfileIdForImport(dto.qualityProfileId);
        let rootPath;
        if (dto.rootFolderId) {
            const rf = await this.rootFolderRepo.findOne({ where: { id: dto.rootFolderId } });
            if (rf)
                rootPath = rf.path;
        }
        if (dto.type === enums_1.MediaType.MOVIE) {
            const details = await this.tmdb.getMovieDetails(dto.tmdbId);
            return this.persistImportedMovie(details, qualityProfileId, rootPath);
        }
        const details = await this.tmdb.getTvShowDetails(dto.tmdbId);
        const seasons = await this.tmdb.getTvShowSeasons(dto.tmdbId);
        return this.persistImportedSeries(details, seasons, qualityProfileId, rootPath);
    }
    async create(dto) {
        const { tagIds, ...rest } = dto;
        const media = this.mediaRepo.create(rest);
        if (tagIds?.length) {
            media.tags = await this.tagRepo.findByIds(tagIds);
        }
        const saved = await this.mediaRepo.save(media);
        await this.updateSearchVector(saved.id);
        return this.findOne(saved.id);
    }
    async findAll(query) {
        const page = query.page ?? 1;
        const limit = query.limit ?? 25;
        const offset = (page - 1) * limit;
        const qb = this.mediaRepo
            .createQueryBuilder('media')
            .leftJoinAndSelect('media.qualityProfile', 'qualityProfile')
            .leftJoinAndSelect('media.languageProfile', 'languageProfile')
            .leftJoinAndSelect('media.tags', 'tags')
            .leftJoinAndSelect('media.files', 'files');
        this.applyFilters(qb, query);
        if (query.q) {
            this.applyFullTextSearch(qb, query.q);
        }
        const sortBy = query.sortBy ?? 'media.title';
        const sortOrder = query.sortOrder ?? 'ASC';
        qb.orderBy(sortBy.includes('.') ? sortBy : `media.${sortBy}`, sortOrder);
        qb.skip(offset).take(limit);
        const [data, total] = await qb.getManyAndCount();
        const seriesIds = data.filter((m) => m.type === 'series').map((m) => m.id);
        let episodeStatsMap = new Map();
        if (seriesIds.length) {
            const stats = await this.dataSource.query(`SELECT s."mediaId",
                  COUNT(e.id) AS total,
                  COUNT(mf.id) AS downloaded
           FROM seasons s
           JOIN episodes e ON e."seasonId" = s.id
           LEFT JOIN media_files mf ON mf."episodeId" = e.id
           WHERE s."mediaId" = ANY($1) AND s."seasonNumber" > 0
           GROUP BY s."mediaId"`, [seriesIds]);
            episodeStatsMap = new Map(stats.map((s) => [
                s.mediaId,
                { totalEpisodes: parseInt(s.total, 10), downloadedEpisodes: parseInt(s.downloaded, 10) },
            ]));
        }
        const enriched = data.map((m) => {
            const stats = episodeStatsMap.get(m.id);
            return {
                ...m,
                sizeOnDisk: (m.files ?? []).reduce((sum, f) => sum + Number(f.size), 0),
                episodeStats: stats ?? undefined,
            };
        });
        return { data: enriched, total };
    }
    async findOne(id) {
        const media = await this.mediaRepo.findOne({
            where: { id },
            relations: [
                'tags',
                'seasons',
                'seasons.episodes',
                'files',
                'qualityProfile',
                'languageProfile',
            ],
        });
        if (!media) {
            throw new common_1.NotFoundException(`Media #${id} not found`);
        }
        if (media.seasons?.length) {
            media.seasons.sort((a, b) => a.seasonNumber - b.seasonNumber);
            for (const s of media.seasons) {
                s.episodes?.sort((a, b) => a.episodeNumber - b.episodeNumber);
            }
        }
        return media;
    }
    async update(id, dto) {
        const media = await this.findOne(id);
        const { tagIds, ...rest } = dto;
        Object.assign(media, rest);
        if (tagIds !== undefined) {
            media.tags = tagIds.length
                ? await this.tagRepo.findByIds(tagIds)
                : [];
        }
        const saved = await this.mediaRepo.save(media);
        await this.updateSearchVector(saved.id);
        return this.findOne(saved.id);
    }
    async updatePath(id, path) {
        await this.findOne(id);
        await this.mediaRepo.update(id, { path });
        return this.findOne(id);
    }
    async updateProfiles(id, dto) {
        await this.findOne(id);
        const patch = {};
        if (dto.qualityProfileId !== undefined) {
            if (dto.qualityProfileId !== null) {
                await this.profiles.findOneQualityProfile(dto.qualityProfileId);
            }
            patch.qualityProfileId = dto.qualityProfileId;
        }
        if (dto.languageProfileId !== undefined) {
            if (dto.languageProfileId !== null) {
                await this.profiles.findOneLanguageProfile(dto.languageProfileId);
            }
            patch.languageProfileId = dto.languageProfileId;
        }
        if (Object.keys(patch).length === 0) {
            throw new common_1.BadRequestException('Provide at least one of qualityProfileId or languageProfileId');
        }
        await this.mediaRepo.update({ id }, patch);
        return this.findOne(id);
    }
    async remove(id) {
        const media = await this.findOne(id);
        await this.mediaRepo.remove(media);
    }
    async getCalendar(dto) {
        function toDateStr(v) {
            if (!v)
                return null;
            if (v instanceof Date) {
                const y = v.getUTCFullYear();
                const m = String(v.getUTCMonth() + 1).padStart(2, '0');
                const d = String(v.getUTCDate()).padStart(2, '0');
                return `${y}-${m}-${d}`;
            }
            return String(v).slice(0, 10);
        }
        let start;
        let end;
        if (dto.start && dto.end) {
            start = dto.start.slice(0, 10);
            end = dto.end.slice(0, 10);
        }
        else {
            const now = new Date();
            const y = now.getFullYear();
            const m = now.getMonth();
            start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
            const last = new Date(y, m + 1, 0).getDate();
            end = `${y}-${String(m + 1).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
        }
        const results = [];
        if (!dto.type || dto.type === enums_1.MediaType.MOVIE) {
            const movies = await this.mediaRepo
                .createQueryBuilder('m')
                .where('m.type = :type', { type: enums_1.MediaType.MOVIE })
                .andWhere(new typeorm_2.Brackets((qb) => {
                qb.where('m.inCinemas BETWEEN :start AND :end', { start, end })
                    .orWhere('m.digitalRelease BETWEEN :start AND :end', { start, end })
                    .orWhere('m.physicalRelease BETWEEN :start AND :end', { start, end })
                    .orWhere('m.releaseDate BETWEEN :start AND :end', { start, end });
            }))
                .getMany();
            const eventFields = [
                { field: 'inCinemas', event: 'cinema' },
                { field: 'digitalRelease', event: 'digital' },
                { field: 'physicalRelease', event: 'physical' },
            ];
            for (const m of movies) {
                let hasSpecificDate = false;
                for (const { field, event } of eventFields) {
                    const d = toDateStr(m[field]);
                    if (d && d >= start && d <= end) {
                        hasSpecificDate = true;
                        results.push({
                            id: m.id,
                            mediaId: m.id,
                            title: m.title,
                            type: 'movie',
                            event,
                            date: d,
                            posterUrl: m.posterUrl,
                            status: m.status,
                            year: m.year,
                        });
                    }
                }
                const rd = toDateStr(m.releaseDate);
                if (!hasSpecificDate && rd && rd >= start && rd <= end) {
                    results.push({
                        id: m.id,
                        mediaId: m.id,
                        title: m.title,
                        type: 'movie',
                        event: 'release',
                        date: rd,
                        posterUrl: m.posterUrl,
                        status: m.status,
                        year: m.year,
                    });
                }
            }
        }
        if (!dto.type || dto.type === enums_1.MediaType.SERIES) {
            const episodes = await this.episodeRepo
                .createQueryBuilder('ep')
                .innerJoinAndSelect('ep.season', 'season')
                .innerJoinAndSelect('season.media', 'media')
                .where('ep.airDate BETWEEN :start AND :end', { start, end })
                .orderBy('ep.airDate', 'ASC')
                .getMany();
            for (const ep of episodes) {
                results.push({
                    id: ep.id,
                    mediaId: ep.season.media.id,
                    title: ep.season.media.title,
                    type: 'series',
                    event: 'airing',
                    date: toDateStr(ep.airDate) ?? ep.airDate,
                    posterUrl: ep.season.media.posterUrl,
                    status: ep.season.media.status,
                    year: ep.season.media.year,
                    seasonNumber: ep.season.seasonNumber,
                    episodeNumber: ep.episodeNumber,
                    episodeTitle: ep.title,
                    hasFile: ep.hasFile,
                });
            }
        }
        results.sort((a, b) => a.date.localeCompare(b.date));
        return results;
    }
    async getHistory(dto) {
        const page = dto.page ?? 1;
        const limit = dto.limit ?? 25;
        const where = {};
        if (dto.mediaId)
            where.mediaId = dto.mediaId;
        const [rows, total] = await this.historyRepo.findAndCount({
            where,
            relations: ['media'],
            order: { createdAt: 'DESC' },
            skip: (page - 1) * limit,
            take: limit,
        });
        const data = rows.map((h) => ({
            id: h.id,
            sourceTitle: h.sourceTitle,
            quality: h.quality,
            status: h.status,
            date: h.createdAt,
            event: h.status,
            mediaId: h.mediaId,
            mediaTitle: h.media?.title ?? null,
            mediaType: h.media?.type ?? null,
        }));
        return { data, total };
    }
    async retryImport(historyId) {
        const entry = await this.historyRepo.findOne({ where: { id: historyId } });
        if (!entry)
            return;
        await this.historyRepo.update(historyId, { status: 'grabbed' });
    }
    async linkTorrentToMedia(mediaId, sourceTitle, clientId) {
        await this.findOne(mediaId);
        return this.historyRepo.save(this.historyRepo.create({
            mediaId,
            sourceTitle,
            downloadClientId: clientId ?? undefined,
            quality: this.parseQuality(sourceTitle),
            status: 'grabbed',
        }));
    }
    parseQuality(title) {
        const u = title.toUpperCase();
        if (u.includes('2160P') || u.includes('4K') || u.includes('UHD'))
            return '2160p';
        if (u.includes('1080P'))
            return '1080p';
        if (u.includes('720P'))
            return '720p';
        if (u.includes('480P'))
            return '480p';
        if (u.includes('REMUX'))
            return 'Remux';
        if (u.includes('BLURAY') || u.includes('BLU-RAY'))
            return 'Bluray';
        if (u.includes('WEBRIP'))
            return 'WEBRip';
        if (u.includes('WEB-DL') || u.includes('WEBDL'))
            return 'WEB-DL';
        if (u.includes('WEB'))
            return 'WEB';
        if (u.includes('HDTV'))
            return 'HDTV';
        return '';
    }
    async updateSeasonMonitored(seasonId, monitored) {
        const season = await this.seasonRepo.findOne({ where: { id: seasonId } });
        if (!season)
            throw new common_1.NotFoundException(`Season #${seasonId} not found`);
        season.monitored = monitored;
        return this.seasonRepo.save(season);
    }
    async updateEpisodeMonitored(episodeId, monitored) {
        const episode = await this.episodeRepo.findOne({
            where: { id: episodeId },
        });
        if (!episode)
            throw new common_1.NotFoundException(`Episode #${episodeId} not found`);
        episode.monitored = monitored;
        return this.episodeRepo.save(episode);
    }
    async deleteMediaFile(mediaId, fileId, deleteOnDisk) {
        const media = await this.mediaRepo.findOne({ where: { id: mediaId } });
        if (!media)
            throw new common_1.NotFoundException(`Media #${mediaId} not found`);
        const file = await this.mediaFileRepo.findOne({ where: { id: fileId, mediaId } });
        if (!file)
            throw new common_1.NotFoundException(`File #${fileId} not found`);
        if (deleteOnDisk && media.path) {
            const fs = await import('fs');
            const path = await import('path');
            const fullPath = path.join(media.path, file.relativePath);
            try {
                fs.unlinkSync(fullPath);
                this.log.log(`Deleted file on disk: ${fullPath}`);
            }
            catch (err) {
                const code = err.code;
                if (code !== 'ENOENT')
                    throw err;
                this.log.warn(`File not found on disk (already deleted?): ${fullPath}`);
            }
        }
        await this.mediaFileRepo.remove(file);
    }
    async deleteHistoryEntry(id) {
        const entry = await this.historyRepo.findOne({ where: { id } });
        if (!entry)
            throw new common_1.NotFoundException(`History entry #${id} not found`);
        await this.historyRepo.remove(entry);
    }
    async refreshMetadata(id) {
        const media = await this.mediaRepo.findOne({ where: { id } });
        if (!media)
            throw new common_1.NotFoundException(`Media #${id} not found`);
        const key = this.config.get('TMDB_API_KEY', '');
        if (!key?.trim()) {
            throw new common_1.BadRequestException('TMDB API key is not configured');
        }
        if (media.type === enums_1.MediaType.MOVIE) {
            const details = await this.tmdb.getMovieDetails(media.tmdbId);
            await this.mediaRepo.update(media.id, {
                ...this.buildMediaFieldsFromTmdb(details, enums_1.MediaType.MOVIE),
            });
        }
        else {
            const details = await this.tmdb.getTvShowDetails(media.tmdbId);
            await this.mediaRepo.update(media.id, {
                ...this.buildMediaFieldsFromTmdb(details, enums_1.MediaType.SERIES),
            });
            await this.refreshSeriesEpisodes(media);
        }
        await this.updateSearchVector(media.id);
        return this.findOne(media.id);
    }
    async refreshSeriesEpisodes(media) {
        const tmdbSeasons = await this.tmdb.getTvShowSeasons(media.tmdbId);
        const dbSeasons = await this.seasonRepo.find({
            where: { mediaId: media.id },
            relations: ['episodes'],
        });
        const dbSeasonMap = new Map(dbSeasons.map((s) => [s.seasonNumber, s]));
        for (const sd of tmdbSeasons) {
            let dbSeason = dbSeasonMap.get(sd.seasonNumber);
            if (!dbSeason) {
                dbSeason = await this.seasonRepo.save(this.seasonRepo.create({
                    mediaId: media.id,
                    seasonNumber: sd.seasonNumber,
                    monitored: true,
                }));
                dbSeason.episodes = [];
            }
            const dbEpMap = new Map(dbSeason.episodes.map((e) => [e.episodeNumber, e]));
            for (const ep of sd.episodes) {
                const existing = dbEpMap.get(ep.episodeNumber);
                if (existing) {
                    const updates = {};
                    if (ep.title && ep.title !== existing.title)
                        updates.title = ep.title;
                    if (ep.overview && ep.overview !== existing.overview)
                        updates.overview = ep.overview;
                    if (ep.airDate && ep.airDate !== existing.airDate)
                        updates.airDate = ep.airDate;
                    if (Object.keys(updates).length > 0) {
                        await this.episodeRepo.update(existing.id, updates);
                    }
                }
                else {
                    await this.episodeRepo.insert({
                        seasonId: dbSeason.id,
                        episodeNumber: ep.episodeNumber,
                        title: ep.title || undefined,
                        overview: ep.overview || undefined,
                        airDate: ep.airDate || undefined,
                        monitored: true,
                    });
                }
            }
        }
    }
    applyFilters(qb, query) {
        if (query.type) {
            qb.andWhere('media.type = :type', { type: query.type });
        }
        if (query.status) {
            qb.andWhere('media.status = :status', { status: query.status });
        }
        if (query.monitored !== undefined) {
            qb.andWhere('media.monitored = :monitored', {
                monitored: query.monitored,
            });
        }
        if (query.year) {
            qb.andWhere('media.year = :year', { year: query.year });
        }
        if (query.genre) {
            qb.andWhere('media.genres @> :genre', {
                genre: JSON.stringify([query.genre]),
            });
        }
        if (query.tagId) {
            qb.andWhere('tags.id = :tagId', { tagId: query.tagId });
        }
        if (query.qualityProfileId) {
            qb.andWhere('media.qualityProfileId = :qpId', {
                qpId: query.qualityProfileId,
            });
        }
        if (query.languageProfileId) {
            qb.andWhere('media.languageProfileId = :lpId', {
                lpId: query.languageProfileId,
            });
        }
    }
    applyFullTextSearch(qb, searchTerm) {
        qb.addSelect(`ts_rank(media."searchVector", plainto_tsquery('french', :q))`, 'rank');
        qb.andWhere(`(
        media."searchVector" @@ plainto_tsquery('french', :q)
        OR media.title ILIKE :like
        OR media."originalTitle" ILIKE :like
        OR similarity(media.title, :q) > 0.3
      )`, { q: searchTerm, like: `%${searchTerm}%` });
        qb.orderBy('rank', 'DESC');
    }
    async updateSearchVector(mediaId) {
        await this.dataSource.query(`UPDATE media SET "searchVector" =
        setweight(to_tsvector('french', COALESCE(title, '')), 'A') ||
        setweight(to_tsvector('french', COALESCE("originalTitle", '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(overview, '')), 'C')
      WHERE id = $1`, [mediaId]);
    }
    mapTmdbStatusToMediaStatus(type, status) {
        const s = (status || '').toLowerCase();
        if (type === enums_1.MediaType.MOVIE) {
            const m = {
                released: enums_1.MediaStatus.RELEASED,
                rumored: enums_1.MediaStatus.TBA,
                rumor: enums_1.MediaStatus.TBA,
                planned: enums_1.MediaStatus.ANNOUNCED,
                'in production': enums_1.MediaStatus.ANNOUNCED,
                'post production': enums_1.MediaStatus.ANNOUNCED,
                canceled: enums_1.MediaStatus.ENDED,
                cancelled: enums_1.MediaStatus.ENDED,
            };
            return m[s] ?? enums_1.MediaStatus.TBA;
        }
        const m = {
            continuing: enums_1.MediaStatus.CONTINUING,
            ended: enums_1.MediaStatus.ENDED,
            announced: enums_1.MediaStatus.ANNOUNCED,
            tba: enums_1.MediaStatus.TBA,
            unknown: enums_1.MediaStatus.TBA,
        };
        return m[s] ?? enums_1.MediaStatus.TBA;
    }
    buildMediaFieldsFromTmdb(details, type) {
        const year = details.year != null && Number.isFinite(details.year)
            ? details.year
            : undefined;
        return {
            title: details.title,
            originalTitle: details.originalTitle ?? details.title,
            year,
            type,
            tmdbId: details.tmdbId,
            imdbId: details.imdbId ?? undefined,
            overview: details.overview ?? undefined,
            status: this.mapTmdbStatusToMediaStatus(type, details.status),
            monitored: true,
            posterUrl: details.posterUrl ?? undefined,
            fanartUrl: details.fanartUrl ?? undefined,
            rating: details.rating ?? undefined,
            genres: details.genres?.length ? details.genres : [],
            runtime: details.runtime ?? undefined,
            releaseDate: details.releaseDate
                ? details.releaseDate.slice(0, 10)
                : undefined,
            inCinemas: details.inCinemas
                ? details.inCinemas.slice(0, 10)
                : undefined,
            digitalRelease: details.digitalRelease
                ? details.digitalRelease.slice(0, 10)
                : undefined,
            physicalRelease: details.physicalRelease
                ? details.physicalRelease.slice(0, 10)
                : undefined,
        };
    }
    async persistImportedMovie(details, qualityProfileId, rootPath) {
        const row = this.mediaRepo.create({
            ...this.buildMediaFieldsFromTmdb(details, enums_1.MediaType.MOVIE),
            ...(qualityProfileId != null ? { qualityProfileId } : {}),
            ...(rootPath ? { path: rootPath } : {}),
        });
        const saved = await this.mediaRepo.save(row);
        await this.updateSearchVector(saved.id);
        return this.findOne(saved.id);
    }
    async persistImportedSeries(details, seasons, qualityProfileId, rootPath) {
        const row = this.mediaRepo.create({
            ...this.buildMediaFieldsFromTmdb(details, enums_1.MediaType.SERIES),
            ...(qualityProfileId != null ? { qualityProfileId } : {}),
            ...(rootPath ? { path: rootPath } : {}),
        });
        const saved = await this.mediaRepo.save(row);
        for (const sd of seasons) {
            const season = this.seasonRepo.create({
                mediaId: saved.id,
                seasonNumber: sd.seasonNumber,
                monitored: true,
            });
            const sSaved = await this.seasonRepo.save(season);
            if (sd.episodes.length > 0) {
                await this.episodeRepo.insert(sd.episodes.map((ep) => ({
                    seasonId: sSaved.id,
                    episodeNumber: ep.episodeNumber,
                    title: ep.title || undefined,
                    overview: ep.overview || undefined,
                    airDate: ep.airDate || undefined,
                    monitored: true,
                })));
            }
        }
        await this.updateSearchVector(saved.id);
        return this.findOne(saved.id);
    }
};
exports.MediaService = MediaService;
exports.MediaService = MediaService = MediaService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(media_entity_1.Media)),
    __param(1, (0, typeorm_1.InjectRepository)(tag_entity_1.Tag)),
    __param(2, (0, typeorm_1.InjectRepository)(season_entity_1.Season)),
    __param(3, (0, typeorm_1.InjectRepository)(episode_entity_1.Episode)),
    __param(4, (0, typeorm_1.InjectRepository)(media_file_entity_1.MediaFile)),
    __param(5, (0, typeorm_1.InjectRepository)(download_history_entity_1.DownloadHistory)),
    __param(6, (0, typeorm_1.InjectRepository)(root_folder_entity_1.RootFolder)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.DataSource,
        tmdb_provider_1.TmdbProvider,
        config_1.ConfigService,
        profiles_service_1.ProfilesService])
], MediaService);
//# sourceMappingURL=media.service.js.map