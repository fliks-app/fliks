import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, SelectQueryBuilder, Brackets } from 'typeorm';
import { Media } from './entities/media.entity';
import { MediaFile } from './entities/media-file.entity';
import { Season } from './entities/season.entity';
import { Episode } from './entities/episode.entity';
import { DownloadHistory } from './entities/download-history.entity';
import { Tag } from '../tags/entities/tag.entity';
import { CreateMediaDto } from './dto/create-media.dto';
import { UpdateMediaDto } from './dto/update-media.dto';
import { SearchMediaDto } from './dto/search-media.dto';
import { ImportTmdbDto } from './dto/import-tmdb.dto';
import { UpdateMediaProfilesDto } from './dto/update-media-profiles.dto';
import { BulkUpdateMediaDto } from './dto/bulk-update-media.dto';
import { CalendarQueryDto } from './dto/calendar-query.dto';
import { TmdbProvider } from '../metadata-providers/providers/tmdb.provider';
import {
  MetadataDetails,
  SeasonDetails,
} from '../metadata-providers/interfaces/metadata-provider.interface';
import { MediaType, MediaStatus } from '../../common/enums';
import { ProfilesService } from '../profiles/profiles.service';
import { RootFolder } from '../root-folders/entities/root-folder.entity';
import { NamingService } from '../scheduler/naming.service';
import {
  getAppQualityById,
  APP_QUALITIES,
} from '../../common/constants/app-qualities';

import { EmbeddedSubtitleService } from '../subtitles/embedded-subtitle.service';
import { MediaServersService } from '../media-servers/media-servers.service';
import { FfprobeService } from '../subtitles/ffprobe.service';
import * as fs from 'fs';
import * as path from 'path';
import { relativePathUnderMediaRoot } from '../../common/utils/media-path.util';

@Injectable()
export class MediaService {
  private readonly log = new Logger(MediaService.name);

  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(Tag)
    private readonly tagRepo: Repository<Tag>,
    @InjectRepository(Season)
    private readonly seasonRepo: Repository<Season>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    @InjectRepository(DownloadHistory)
    private readonly historyRepo: Repository<DownloadHistory>,
    @InjectRepository(RootFolder)
    private readonly rootFolderRepo: Repository<RootFolder>,
    private readonly dataSource: DataSource,
    private readonly tmdb: TmdbProvider,
    private readonly config: ConfigService,
    private readonly profiles: ProfilesService,
    private readonly naming: NamingService,
    private readonly embeddedSubtitle: EmbeddedSubtitleService,
    private readonly mediaServers: MediaServersService,
    private readonly ffprobe: FfprobeService,
  ) {}

  async importFromTmdb(dto: ImportTmdbDto): Promise<Media> {
    const key = this.config.get<string>('TMDB_API_KEY', '');
    if (!key?.trim()) {
      throw new BadRequestException('TMDB API key is not configured');
    }

    const existing = await this.mediaRepo.findOne({
      where: { tmdbId: dto.tmdbId, type: dto.type },
    });
    if (existing) {
      throw new ConflictException('This title is already in the library');
    }

    const qualityProfileId =
      await this.profiles.resolveQualityProfileIdForImport(
        dto.qualityProfileId,
      );

    const languageProfileId =
      await this.profiles.resolveLanguageProfileIdForImport(
        dto.languageProfileId,
      );

    let resolvedRootFolderId: number | undefined;
    if (dto.rootFolderId) {
      const rf = await this.rootFolderRepo.findOne({
        where: { id: dto.rootFolderId },
      });
      if (rf && rf.mediaTypes?.includes(dto.type)) {
        resolvedRootFolderId = rf.id;
      }
    }

    // Fallback to default root folder setting only
    if (!resolvedRootFolderId) {
      const defaultKey =
        dto.type === MediaType.MOVIE
          ? 'default_root_folder_movie'
          : 'default_root_folder_series';
      const [row] = (await this.dataSource.query(
        `SELECT value FROM app_settings WHERE key = $1 LIMIT 1`,
        [defaultKey],
      )) as { value: string | null }[];
      if (row?.value) {
        const rfId = Number(row.value);
        if (rfId) {
          const rf = await this.rootFolderRepo.findOne({ where: { id: rfId } });
          if (rf && rf.mediaTypes?.includes(dto.type)) {
            resolvedRootFolderId = rf.id;
          }
        }
      }
    }

    if (!resolvedRootFolderId) {
      throw new BadRequestException(
        'No compatible root folder found. Set a default root folder for this media type in settings.',
      );
    }

    // Load folder format settings
    const fmtKeys = [
      'naming_movie_folder_format',
      'naming_series_folder_format',
    ];
    const fmtRows: { key: string; value: string }[] =
      await this.dataSource.query(
        `SELECT key, value FROM app_settings WHERE key = ANY($1)`,
        [fmtKeys],
      );
    const fmtMap = Object.fromEntries(fmtRows.map((r) => [r.key, r.value]));

    if (dto.type === MediaType.MOVIE) {
      const details = await this.tmdb.getMovieDetails(dto.tmdbId);
      const movieFolderFormat =
        fmtMap['naming_movie_folder_format'] ??
        '{Movie Title} ({Release Year})';
      const folderName = this.naming.applyMovieFolderFormat(movieFolderFormat, {
        title: details.title,
        originalTitle: details.originalTitle,
        year: details.year,
        tmdbId: details.tmdbId,
      });
      return this.persistImportedMovie(
        details,
        qualityProfileId,
        languageProfileId,
        resolvedRootFolderId,
        folderName,
      );
    }

    const details = await this.tmdb.getTvShowDetails(dto.tmdbId);
    const seasons = await this.tmdb.getTvShowSeasons(dto.tmdbId);
    const seriesFolderFormat =
      fmtMap['naming_series_folder_format'] ?? '{Series Title}';
    const folderName = this.naming.applySeriesFolderFormat(seriesFolderFormat, {
      seriesTitle: details.title,
      year: details.year,
      tmdbId: details.tmdbId,
    });
    return this.persistImportedSeries(
      details,
      seasons,
      qualityProfileId,
      languageProfileId,
      resolvedRootFolderId,
      folderName,
    );
  }

  async create(dto: CreateMediaDto): Promise<Media> {
    const { tagIds, ...rest } = dto;
    const media = this.mediaRepo.create(rest);

    if (tagIds?.length) {
      media.tags = await this.tagRepo.findByIds(tagIds);
    }

    const saved = await this.mediaRepo.save(media);
    await this.updateSearchVector(saved.id);
    return this.findOne(saved.id);
  }

  async getCounts(): Promise<{ movies: number; series: number }> {
    const [movies, series] = await Promise.all([
      this.mediaRepo.count({ where: { type: 'movie' as MediaType } }),
      this.mediaRepo.count({ where: { type: 'series' as MediaType } }),
    ]);
    return { movies, series };
  }

  async findAll(
    query: SearchMediaDto,
    userId?: number,
  ): Promise<{ data: Media[]; total: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const offset = (page - 1) * limit;

    const qb = this.mediaRepo
      .createQueryBuilder('media')
      .leftJoinAndSelect('media.rootFolder', 'rootFolder')
      .leftJoinAndSelect('media.qualityProfile', 'qualityProfile')
      .leftJoinAndSelect('media.languageProfile', 'languageProfile')
      .leftJoinAndSelect('media.tags', 'tags')
      .leftJoinAndSelect('media.files', 'files');

    this.applyFilters(qb, query);

    if (query.excludeWatched && userId) {
      // Movies: any completed playback for that media = watched.
      // Series: watched only when every episode with hasFile has a completed playback row.
      qb.andWhere(
        `(media.id NOT IN (
            SELECT DISTINCT ps."mediaId" FROM playback_states ps
            INNER JOIN media m ON m.id = ps."mediaId"
            WHERE ps."userId" = :userId AND ps.completed = true AND m.type = 'movie'
          )
          AND media.id NOT IN (
            SELECT m2.id FROM media m2
            WHERE m2.type = 'series'
            AND EXISTS (
              SELECT 1 FROM seasons s
              JOIN episodes e ON e."seasonId" = s.id
              WHERE s."mediaId" = m2.id AND s."seasonNumber" > 0 AND e."hasFile" = true
            )
            AND NOT EXISTS (
              SELECT 1 FROM seasons s
              JOIN episodes e ON e."seasonId" = s.id
              WHERE s."mediaId" = m2.id AND s."seasonNumber" > 0 AND e."hasFile" = true
              AND NOT EXISTS (
                SELECT 1 FROM playback_states ps
                WHERE ps."userId" = :userId AND ps."episodeId" = e.id AND ps.completed = true
              )
            )
          ))`,
        { userId },
      );
    }

    if (query.q) {
      this.applyFullTextSearch(qb, query.q);
    }

    const sortBy = query.sortBy ?? 'media.title';
    const sortOrder = query.sortOrder ?? 'ASC';
    qb.orderBy(sortBy.includes('.') ? sortBy : `media.${sortBy}`, sortOrder);

    if (limit > 0) {
      qb.skip(offset).take(limit);
    }

    const [data, total] = await qb.getManyAndCount();

    // For series: attach episode stats
    const seriesIds = data
      .filter((m) => m.type === MediaType.SERIES)
      .map((m) => m.id);
    let episodeStatsMap = new Map<
      number,
      { totalEpisodes: number; downloadedEpisodes: number }
    >();
    if (seriesIds.length) {
      const stats: { mediaId: number; total: string; downloaded: string }[] =
        await this.dataSource.query(
          `SELECT s."mediaId",
                  COUNT(e.id) AS total,
                  COUNT(mf.id) AS downloaded
           FROM seasons s
           JOIN episodes e ON e."seasonId" = s.id
           LEFT JOIN media_files mf ON mf."episodeId" = e.id
           WHERE s."mediaId" = ANY($1) AND s."seasonNumber" > 0
           GROUP BY s."mediaId"`,
          [seriesIds],
        );
      episodeStatsMap = new Map(
        stats.map((s) => [
          s.mediaId,
          {
            totalEpisodes: parseInt(s.total, 10),
            downloadedEpisodes: parseInt(s.downloaded, 10),
          },
        ]),
      );
    }

    let enriched = data.map((m) => {
      const stats = episodeStatsMap.get(m.id);
      return Object.assign(m, {
        sizeOnDisk: (m.files ?? []).reduce((sum, f) => sum + Number(f.size), 0),
        episodeStats: stats ?? undefined,
      });
    });

    if (query.cutoffUnmet === true) {
      const qualityByName = new Map(APP_QUALITIES.map((q) => [q.name, q]));
      enriched = enriched.filter((m) => {
        if (!m.files?.length || !m.qualityProfile) return false;
        const cutoffQuality = getAppQualityById(m.qualityProfile.cutoff);
        if (!cutoffQuality) return false;
        return !m.files.some((f) => {
          const fq = qualityByName.get(f.quality);
          return fq && fq.rank >= cutoffQuality.rank;
        });
      });
    }

    return { data: enriched, total };
  }

  async findByTmdbId(tmdbId: number, type: MediaType): Promise<Media | null> {
    return this.mediaRepo.findOne({ where: { tmdbId, type } });
  }

  async findOne(id: number): Promise<Media> {
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
      throw new NotFoundException(`Media #${id} not found`);
    }
    if (media.seasons?.length) {
      media.seasons.sort((a, b) => a.seasonNumber - b.seasonNumber);
      for (const s of media.seasons) {
        s.episodes?.sort((a, b) => a.episodeNumber - b.episodeNumber);
      }
    }
    if (media.type === MediaType.SERIES && media.seasons?.length) {
      const epIdsWithTrackedFile = new Set(
        (media.files ?? [])
          .map((f) => f.episodeId)
          .filter((id): id is number => id != null && id > 0),
      );
      for (const s of media.seasons) {
        for (const e of s.episodes ?? []) {
          if (epIdsWithTrackedFile.has(e.id)) {
            e.hasFile = true;
          }
        }
      }
    }
    return media;
  }

  async update(id: number, dto: UpdateMediaDto): Promise<Media> {
    const media = await this.findOne(id);
    const { tagIds, path: _path, ...rest } = dto;

    Object.assign(media, rest);

    if (tagIds !== undefined) {
      media.tags = tagIds.length ? await this.tagRepo.findByIds(tagIds) : [];
    }

    const saved = await this.mediaRepo.save(media);
    await this.updateSearchVector(saved.id);
    return this.findOne(saved.id);
  }

  async updateRootFolder(id: number, rootFolderId: number): Promise<Media> {
    await this.findOne(id);
    await this.mediaRepo.update(id, { rootFolderId });
    return this.findOne(id);
  }

  async updateProfiles(
    id: number,
    dto: UpdateMediaProfilesDto,
  ): Promise<Media> {
    await this.findOne(id);
    const patch: {
      qualityProfileId?: number | null;
      languageProfileId?: number | null;
    } = {};
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
      throw new BadRequestException(
        'Provide at least one of qualityProfileId or languageProfileId',
      );
    }
    await this.mediaRepo.update(
      { id },
      patch as Parameters<Repository<Media>['update']>[1],
    );
    return this.findOne(id);
  }

  async bulkUpdate(dto: BulkUpdateMediaDto): Promise<{ updated: number }> {
    const patch: Partial<Record<string, unknown>> = {};

    if (dto.qualityProfileId !== undefined) {
      patch.qualityProfileId = dto.qualityProfileId;
    }
    if (dto.languageProfileId !== undefined) {
      patch.languageProfileId = dto.languageProfileId;
    }
    if (dto.monitored !== undefined) {
      patch.monitored = dto.monitored;
    }
    if (dto.rootFolder !== undefined) {
      patch.rootFolderId = dto.rootFolder;
    }

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('Provide at least one field to update');
    }

    const result = await this.mediaRepo
      .createQueryBuilder()
      .update(Media)
      .set(patch)
      .whereInIds(dto.ids)
      .execute();

    return { updated: result.affected ?? 0 };
  }

  async remove(id: number): Promise<void> {
    const media = await this.findOne(id);
    const title = media.title;
    const mediaPath = media.path;
    await this.mediaRepo.remove(media);
    void this.mediaServers.dispatch('media.deleted', {
      title,
      path: mediaPath,
    });
  }

  // ---------------------------------------------------------------------------
  // Calendar
  // ---------------------------------------------------------------------------

  async getCalendar(dto: CalendarQueryDto) {
    // TypeORM may return PostgreSQL `date` columns as Date objects.
    // Normalise to YYYY-MM-DD string to avoid timezone shifts.
    function toDateStr(v: unknown): string | null {
      if (!v) return null;
      if (v instanceof Date) {
        const y = v.getUTCFullYear();
        const m = String(v.getUTCMonth() + 1).padStart(2, '0');
        const d = String(v.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
      }
      if (typeof v === 'string') return v.slice(0, 10);
      if (typeof v === 'number' || typeof v === 'bigint')
        return String(v).slice(0, 10);
      return null;
    }
    let start: string;
    let end: string;
    if (dto.start && dto.end) {
      start = dto.start.slice(0, 10);
      end = dto.end.slice(0, 10);
    } else {
      const now = new Date();
      const y = now.getFullYear();
      const m = now.getMonth();
      start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
      const last = new Date(y, m + 1, 0).getDate();
      end = `${y}-${String(m + 1).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
    }

    type CalendarEntry = {
      id: number;
      mediaId: number;
      title: string;
      type: 'movie' | 'series';
      event: string;
      date: string;
      posterUrl: string | null;
      status: string;
      year: number;
      seasonNumber?: number;
      episodeNumber?: number;
      episodeTitle?: string;
      hasFile?: boolean;
    };

    const results: CalendarEntry[] = [];

    // 1. Movies — one entry per event type with a date in range
    if (!dto.type || dto.type === MediaType.MOVIE) {
      const movies = await this.mediaRepo
        .createQueryBuilder('m')
        .where('m.type = :type', { type: MediaType.MOVIE })
        .andWhere(
          new Brackets((qb) => {
            qb.where('m.inCinemas BETWEEN :start AND :end', { start, end })
              .orWhere('m.digitalRelease BETWEEN :start AND :end', {
                start,
                end,
              })
              .orWhere('m.physicalRelease BETWEEN :start AND :end', {
                start,
                end,
              })
              .orWhere('m.releaseDate BETWEEN :start AND :end', { start, end });
          }),
        )
        .getMany();

      const eventFields: { field: keyof Media; event: string }[] = [
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
        // Fallback to generic releaseDate if no specific dates
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

    // 2. Episodes with airDate in range
    if (!dto.type || dto.type === MediaType.SERIES) {
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

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  async updateSeasonMonitored(
    seasonId: number,
    monitored: boolean,
  ): Promise<Season> {
    const season = await this.seasonRepo.findOne({ where: { id: seasonId } });
    if (!season) throw new NotFoundException(`Season #${seasonId} not found`);
    season.monitored = monitored;
    return this.seasonRepo.save(season);
  }

  async updateEpisodeMonitored(
    episodeId: number,
    monitored: boolean,
  ): Promise<Episode> {
    const episode = await this.episodeRepo.findOne({
      where: { id: episodeId },
    });
    if (!episode)
      throw new NotFoundException(`Episode #${episodeId} not found`);
    episode.monitored = monitored;
    return this.episodeRepo.save(episode);
  }

  async deleteMediaFile(
    mediaId: number,
    fileId: number,
    deleteOnDisk: boolean,
  ): Promise<void> {
    const media = await this.mediaRepo.findOne({ where: { id: mediaId } });
    if (!media) throw new NotFoundException(`Media #${mediaId} not found`);

    const file = await this.mediaFileRepo.findOne({
      where: { id: fileId, mediaId },
    });
    if (!file) throw new NotFoundException(`File #${fileId} not found`);

    if (deleteOnDisk && media.path) {
      const fs = await import('fs');
      const path = await import('path');
      const fullPath = path.join(media.path, file.relativePath);
      try {
        fs.unlinkSync(fullPath);
        this.log.log(`Deleted file on disk: ${fullPath}`);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw err;
        this.log.warn(`File not found on disk (already deleted?): ${fullPath}`);
      }
    }

    const episodeId = file.episodeId;
    await this.mediaFileRepo.remove(file);
    if (episodeId != null) {
      const remaining = await this.mediaFileRepo.count({
        where: { episodeId },
      });
      if (remaining === 0) {
        await this.episodeRepo.update(episodeId, { hasFile: false });
      }
    }

    void this.mediaServers.dispatch('file.deleted', {
      title: media.title,
      path: media.path,
    });
  }

  async refreshMetadata(id: number): Promise<Media> {
    const media = await this.mediaRepo.findOne({ where: { id } });
    if (!media) throw new NotFoundException(`Media #${id} not found`);

    const key = this.config.get<string>('TMDB_API_KEY', '');
    if (!key?.trim()) {
      throw new BadRequestException('TMDB API key is not configured');
    }

    if (media.type === MediaType.MOVIE) {
      const details = await this.tmdb.getMovieDetails(media.tmdbId);
      await this.mediaRepo.update(media.id, {
        ...this.buildMediaFieldsFromTmdb(details, MediaType.MOVIE),
      });
    } else {
      const details = await this.tmdb.getTvShowDetails(media.tmdbId);
      await this.mediaRepo.update(media.id, {
        ...this.buildMediaFieldsFromTmdb(details, MediaType.SERIES),
      });
      await this.refreshSeriesEpisodes(media);
    }

    await this.updateSearchVector(media.id);

    // Refresh embedded subtitles for all files
    const files = await this.mediaFileRepo.find({
      where: { mediaId: media.id },
    });
    for (const file of files) {
      await this.embeddedSubtitle.detectAndStore(
        media.id,
        file.id,
        file.episodeId ?? undefined,
      );
    }

    await this.mediaRepo.update(media.id, {
      metadataRefreshedAt: new Date(),
    });

    return this.findOne(media.id);
  }

  private async refreshSeriesEpisodes(media: Media): Promise<void> {
    const tmdbSeasons = await this.tmdb.getTvShowSeasons(media.tmdbId);
    const dbSeasons = await this.seasonRepo.find({
      where: { mediaId: media.id },
      relations: ['episodes'],
    });
    const dbSeasonMap = new Map(dbSeasons.map((s) => [s.seasonNumber, s]));

    for (const sd of tmdbSeasons) {
      let dbSeason = dbSeasonMap.get(sd.seasonNumber);
      if (!dbSeason) {
        dbSeason = await this.seasonRepo.save(
          this.seasonRepo.create({
            mediaId: media.id,
            seasonNumber: sd.seasonNumber,
            monitored: true,
          }),
        );
        dbSeason.episodes = [];
      }

      const dbEpMap = new Map(
        dbSeason.episodes.map((e) => [e.episodeNumber, e]),
      );

      for (const ep of sd.episodes) {
        const existing = dbEpMap.get(ep.episodeNumber);
        if (existing) {
          const updates: Partial<Episode> = {};
          if (ep.title && ep.title !== existing.title) updates.title = ep.title;
          if (ep.overview && ep.overview !== existing.overview)
            updates.overview = ep.overview;
          if (ep.airDate && ep.airDate !== existing.airDate)
            updates.airDate = ep.airDate;
          if (ep.stillUrl != null && ep.stillUrl !== existing.stillUrl)
            updates.stillUrl = ep.stillUrl ?? undefined;
          if (ep.runtime != null && ep.runtime !== existing.runtime)
            updates.runtime = ep.runtime;
          if (Object.keys(updates).length > 0) {
            await this.episodeRepo.update(existing.id, updates);
          }
        } else {
          await this.episodeRepo.insert({
            seasonId: dbSeason.id,
            episodeNumber: ep.episodeNumber,
            title: ep.title || undefined,
            overview: ep.overview || undefined,
            airDate: ep.airDate || undefined,
            runtime: ep.runtime ?? undefined,
            stillUrl: ep.stillUrl || undefined,
            monitored: true,
          });
        }
      }
    }
  }

  private applyFilters(
    qb: SelectQueryBuilder<Media>,
    query: SearchMediaDto,
  ): void {
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
    if (query.missing === true) {
      qb.andWhere('files.id IS NULL');
    } else if (query.missing === false) {
      qb.andWhere('files.id IS NOT NULL');
    }
    if (query.letter) {
      const letter = query.letter.toUpperCase();
      if (letter === '#') {
        qb.andWhere(`media.title !~ '^[A-Za-z]'`);
      } else if (/^[A-Z]$/.test(letter)) {
        qb.andWhere(`UPPER(LEFT(media.title, 1)) = :letter`, { letter });
      }
    }
  }

  private applyFullTextSearch(
    qb: SelectQueryBuilder<Media>,
    searchTerm: string,
  ): void {
    qb.addSelect(
      `ts_rank(media."searchVector", plainto_tsquery('french', :q))`,
      'rank',
    );
    qb.andWhere(
      `(
        media."searchVector" @@ plainto_tsquery('french', :q)
        OR media.title ILIKE :like
        OR media."originalTitle" ILIKE :like
        OR similarity(media.title, :q) > 0.3
      )`,
      { q: searchTerm, like: `%${searchTerm}%` },
    );
    qb.orderBy('rank', 'DESC');
  }

  private async updateSearchVector(mediaId: number): Promise<void> {
    await this.dataSource.query(
      `UPDATE media SET "searchVector" =
        setweight(to_tsvector('french', COALESCE(title, '')), 'A') ||
        setweight(to_tsvector('french', COALESCE("originalTitle", '')), 'B') ||
        setweight(to_tsvector('french', COALESCE(overview, '')), 'C')
      WHERE id = $1`,
      [mediaId],
    );
  }

  private mapTmdbStatusToMediaStatus(
    type: MediaType,
    status: string,
  ): MediaStatus {
    const s = (status || '').toLowerCase();
    if (type === MediaType.MOVIE) {
      const m: Record<string, MediaStatus> = {
        released: MediaStatus.RELEASED,
        rumored: MediaStatus.TBA,
        rumor: MediaStatus.TBA,
        planned: MediaStatus.ANNOUNCED,
        'in production': MediaStatus.ANNOUNCED,
        'post production': MediaStatus.ANNOUNCED,
        canceled: MediaStatus.ENDED,
        cancelled: MediaStatus.ENDED,
      };
      return m[s] ?? MediaStatus.TBA;
    }
    const m: Record<string, MediaStatus> = {
      continuing: MediaStatus.CONTINUING,
      ended: MediaStatus.ENDED,
      announced: MediaStatus.ANNOUNCED,
      tba: MediaStatus.TBA,
      unknown: MediaStatus.TBA,
    };
    return m[s] ?? MediaStatus.TBA;
  }

  private buildMediaFieldsFromTmdb(
    details: MetadataDetails,
    type: MediaType,
  ): Partial<Media> {
    const year =
      details.year != null && Number.isFinite(details.year)
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
      inCinemas: details.inCinemas ? details.inCinemas.slice(0, 10) : undefined,
      digitalRelease: details.digitalRelease
        ? details.digitalRelease.slice(0, 10)
        : undefined,
      physicalRelease: details.physicalRelease
        ? details.physicalRelease.slice(0, 10)
        : undefined,
    };
  }

  private async persistImportedMovie(
    details: MetadataDetails,
    qualityProfileId: number | null,
    languageProfileId: number | null,
    rootFolderId?: number,
    folderName?: string,
  ): Promise<Media> {
    const row = this.mediaRepo.create({
      ...this.buildMediaFieldsFromTmdb(details, MediaType.MOVIE),
      metadataRefreshedAt: new Date(),
      ...(qualityProfileId != null ? { qualityProfileId } : {}),
      ...(languageProfileId != null ? { languageProfileId } : {}),
      ...(rootFolderId ? { rootFolderId } : {}),
      ...(folderName ? { folderName } : {}),
    });
    const saved = await this.mediaRepo.save(row);
    await this.updateSearchVector(saved.id);
    return this.findOne(saved.id);
  }

  private async persistImportedSeries(
    details: MetadataDetails,
    seasons: SeasonDetails[],
    qualityProfileId: number | null,
    languageProfileId: number | null,
    rootFolderId?: number,
    folderName?: string,
  ): Promise<Media> {
    const row = this.mediaRepo.create({
      ...this.buildMediaFieldsFromTmdb(details, MediaType.SERIES),
      metadataRefreshedAt: new Date(),
      ...(qualityProfileId != null ? { qualityProfileId } : {}),
      ...(languageProfileId != null ? { languageProfileId } : {}),
      ...(rootFolderId ? { rootFolderId } : {}),
      ...(folderName ? { folderName } : {}),
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
        await this.episodeRepo.insert(
          sd.episodes.map((ep) => ({
            seasonId: sSaved.id,
            episodeNumber: ep.episodeNumber,
            title: ep.title || undefined,
            overview: ep.overview || undefined,
            airDate: ep.airDate || undefined,
            runtime: ep.runtime ?? undefined,
            monitored: true,
          })),
        );
      }
    }

    await this.updateSearchVector(saved.id);
    return this.findOne(saved.id);
  }

  async renameFiles(mediaId: number): Promise<{ renamed: number }> {
    const media = await this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: ['files', 'seasons', 'seasons.episodes'],
    });
    if (!media) throw new NotFoundException(`Media #${mediaId} not found`);
    if (!media.files?.length) return { renamed: 0 };
    if (!media.path)
      throw new BadRequestException('No root folder set for this media');

    const [movieFormatRow] = (await this.dataSource.query(
      `SELECT value FROM app_settings WHERE key = 'movie_format' LIMIT 1`,
    )) as { value: string | null }[];
    const [seriesFormatRow] = (await this.dataSource.query(
      `SELECT value FROM app_settings WHERE key = 'series_format' LIMIT 1`,
    )) as { value: string | null }[];
    const movieFormat =
      movieFormatRow?.value ||
      '{Movie Title} ({Release Year}) - {Quality Full}';
    const seriesFormat =
      seriesFormatRow?.value ||
      '{Series Title} - S{season:00}E{episode:00} - {Episode Title} - {Quality Full}';

    let renamed = 0;
    for (const file of media.files) {
      const ext = path.extname(file.relativePath);
      const oldAbsPath = path.join(media.path, file.relativePath);
      if (!fs.existsSync(oldAbsPath)) continue;

      let newName: string;
      if (media.type === MediaType.MOVIE) {
        newName = this.naming.applyMovieFormat(movieFormat, {
          title: media.title,
          originalTitle: media.originalTitle,
          year: media.year,
          quality: file.quality,
          tmdbId: media.tmdbId,
        });
      } else {
        const episode = media.seasons
          ?.flatMap((s) => s.episodes ?? [])
          .find((e) => e.id === file.episodeId);
        const season = media.seasons?.find((s) =>
          s.episodes?.some((e) => e.id === file.episodeId),
        );
        newName = this.naming.applySeriesFormat(seriesFormat, {
          seriesTitle: media.title,
          season: season?.seasonNumber ?? 1,
          episode: episode?.episodeNumber ?? 1,
          episodeTitle: episode?.title ?? '',
          quality: file.quality,
        });
      }

      const newRelativePath = newName + ext;
      if (newRelativePath === file.relativePath) continue;

      const newAbsPath = path.join(media.path, newRelativePath);
      fs.mkdirSync(path.dirname(newAbsPath), { recursive: true });
      fs.renameSync(oldAbsPath, newAbsPath);
      file.relativePath = newRelativePath;
      await this.mediaFileRepo.save(file);
      renamed++;
    }

    return { renamed };
  }

  // ---------------------------------------------------------------------------
  // Rescan files on disk
  // ---------------------------------------------------------------------------

  private static readonly VIDEO_EXTS = new Set([
    '.mkv',
    '.mp4',
    '.avi',
    '.mov',
    '.ts',
    '.m2ts',
    '.wmv',
    '.flv',
  ]);

  async rescanFiles(
    mediaId: number,
  ): Promise<{ added: number; removed: number; updated: number }> {
    const media = await this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: ['files'],
    });
    if (!media) throw new NotFoundException(`Media #${mediaId} not found`);
    if (!media.path) {
      throw new BadRequestException(
        `Media #${mediaId} has no root path configured`,
      );
    }

    const mediaDir = path.resolve(media.path);
    if (!fs.existsSync(mediaDir)) {
      try {
        fs.mkdirSync(mediaDir, { recursive: true });
        this.log.warn(
          `Rescan: created missing media folder — "${mediaDir}" (media #${mediaId} "${media.title}")`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new BadRequestException(
          `Cannot create media folder "${mediaDir}": ${msg}`,
        );
      }
    }

    this.log.log(
      `Rescan: started — media #${mediaId} "${media.title}" root="${mediaDir}"`,
    );

    // 1. Collect all video files on disk
    const rawDiskFiles = this.collectVideoFilesRecursive(mediaDir, 0, mediaId);
    const diskFiles: string[] = [];
    const diskRelPaths = new Set<string>();
    for (const f of rawDiskFiles) {
      const rel = relativePathUnderMediaRoot(mediaDir, f);
      if (!rel) {
        this.log.error(
          `Rescan[media #${mediaId}]: file is outside resolved media folder — mediaDir="${mediaDir}" file="${f}"`,
        );
        continue;
      }
      diskRelPaths.add(rel);
      diskFiles.push(f);
    }
    this.log.log(
      `Rescan: found ${diskFiles.length} file(s) on disk, ${(media.files ?? []).length} in DB`,
    );

    // 2. Existing DB records
    const dbFiles = media.files ?? [];
    if (diskFiles.length === 0 && dbFiles.length > 0) {
      this.log.warn(
        `Rescan[media #${mediaId}]: no video file on disk, ${dbFiles.length} file(s) still in DB (orphan rows will be removed if paths do not match)`,
      );
    }
    const dbRelPaths = new Set(
      dbFiles.map((f) => f.relativePath.replace(/\\/g, '/')),
    );

    let added = 0;
    let removed = 0;

    // 3. Remove DB records whose files no longer exist on disk
    for (const dbFile of dbFiles) {
      const normPath = dbFile.relativePath?.replace(/\\/g, '/');
      if (!normPath || !diskRelPaths.has(normPath)) {
        if (normPath?.includes('..')) {
          this.log.error(
            `Rescan[media #${mediaId}]: dropping DB file row with unsafe relativePath (not on disk or invalid): "${normPath}"`,
          );
        }
        const episodeId = dbFile.episodeId;
        try {
          await this.mediaFileRepo.remove(dbFile);
          removed++;
          this.log.log(
            `Rescan: removed missing file "${normPath}" for media #${mediaId}`,
          );
          if (episodeId != null) {
            const remaining = await this.mediaFileRepo.count({
              where: { episodeId },
            });
            if (remaining === 0) {
              await this.episodeRepo.update(episodeId, { hasFile: false });
            }
          }
        } catch (err) {
          this.log.error(
            `Rescan[media #${mediaId}]: failed to remove DB row for missing file "${normPath}"`,
            err instanceof Error ? err.stack : err,
          );
        }
      }
    }

    if (removed > 0) {
      this.log.warn(
        `Rescan[media #${mediaId}]: removed ${removed} file row(s) from DB (not found on disk)`,
      );
    }

    // 4. Refresh metadata for existing DB records from disk
    let updated = 0;
    for (const dbFile of dbFiles) {
      const normPath = dbFile.relativePath?.replace(/\\/g, '/');
      if (!normPath || !diskRelPaths.has(normPath)) continue;
      const absPath = path.join(mediaDir, normPath);

      let diskSize: number;
      try {
        diskSize = fs.statSync(absPath).size;
      } catch (err) {
        this.log.warn(
          `Rescan[media #${mediaId}]: cannot stat file for refresh (skipped) — path="${absPath}" relativePath="${normPath}"`,
          err instanceof Error ? err.stack : err,
        );
        continue;
      }

      const filename = path.basename(absPath);

      // Fix missing episodeId for series files (e.g. imported from Sonarr without seasons)
      if (media.type === MediaType.SERIES && dbFile.episodeId == null) {
        const epNums = this.parseEpisodeNumbers(filename);
        if (epNums) {
          try {
            let season = await this.seasonRepo.findOne({
              where: { mediaId: media.id, seasonNumber: epNums.season },
            });
            if (!season) {
              season = await this.seasonRepo.save(
                this.seasonRepo.create({
                  mediaId: media.id,
                  seasonNumber: epNums.season,
                  monitored: true,
                }),
              );
              this.log.log(
                `Rescan: created season ${epNums.season} for media #${mediaId}`,
              );
            }
            let ep = await this.episodeRepo.findOne({
              where: { seasonId: season.id, episodeNumber: epNums.episode },
            });
            if (!ep) {
              ep = await this.episodeRepo.save(
                this.episodeRepo.create({
                  seasonId: season.id,
                  episodeNumber: epNums.episode,
                  monitored: true,
                }),
              );
              this.log.log(
                `Rescan: created episode S${String(epNums.season).padStart(2, '0')}E${String(epNums.episode).padStart(2, '0')} for media #${mediaId}`,
              );
            }
            dbFile.episodeId = ep.id;
            try {
              await this.mediaFileRepo.save(dbFile);
              await this.episodeRepo.update(ep.id, { hasFile: true });
              updated++;
              this.log.log(
                `Rescan: linked "${normPath}" to S${String(epNums.season).padStart(2, '0')}E${String(epNums.episode).padStart(2, '0')} for media #${mediaId}`,
              );
            } catch (err) {
              this.log.error(
                `Rescan[media #${mediaId}]: failed to link file "${normPath}" to episode`,
                err instanceof Error ? err.stack : err,
              );
            }
          } catch (err) {
            this.log.error(
              `Rescan[media #${mediaId}]: failed to create season/episode for refresh "${normPath}"`,
              err instanceof Error ? err.stack : err,
            );
          }
        }
      }

      const sizeChanged = Number(dbFile.size) !== diskSize;
      const si = dbFile.streamInfo;
      const missingStreamInfo =
        !si ||
        si.error ||
        (!si.video?.length && !si.audio?.length) ||
        !('subtitles' in si) ||
        !('durationSeconds' in si);
      const missingColorInfo =
        si?.video?.[0] &&
        (!('colorTransfer' in (si.video[0] ?? {})) ||
          (si.video[0].colorTransfer === 'smpte2084' &&
            !si.video[0].hdrFormat));
      // Check if quality needs correction (e.g. was parsed from filename, now use ffprobe)
      const expectedQuality = this.resolveQuality(
        filename,
        si?.video?.[0]?.height,
        si?.video?.[0]?.width,
      );
      const qualityStale =
        dbFile.quality !== expectedQuality && si?.video?.[0]?.height;

      if (
        sizeChanged ||
        missingStreamInfo ||
        missingColorInfo ||
        qualityStale
      ) {
        dbFile.size = diskSize;
        let streamInfo = si;
        if (sizeChanged || missingStreamInfo || missingColorInfo) {
          try {
            streamInfo = await this.ffprobe.detectMediaFileInfo(absPath);
            if (streamInfo?.video?.[0]) {
              try {
                const crop = await this.ffprobe.detectCrop(
                  absPath,
                  streamInfo.durationSeconds,
                );
                if (crop) streamInfo.video[0].crop = crop;
              } catch (err) {
                this.log.warn(
                  `Rescan[media #${mediaId}]: detectCrop failed on refresh "${normPath}" abs="${absPath}" (metadata otherwise kept)`,
                  err instanceof Error ? err.stack : err,
                );
              }
            }
            dbFile.streamInfo = streamInfo;
          } catch (err) {
            this.log.error(
              `Rescan[media #${mediaId}]: ffprobe failed on refresh "${normPath}" abs="${absPath}"`,
              err instanceof Error ? err.stack : err,
            );
            continue;
          }
        }
        const qualityName = this.resolveQuality(
          filename,
          streamInfo?.video?.[0]?.height,
          streamInfo?.video?.[0]?.width,
        );
        dbFile.quality = qualityName;
        try {
          await this.mediaFileRepo.save(dbFile);
          updated++;
          this.log.log(
            `Rescan: refreshed "${normPath}" for media #${mediaId} (size: ${diskSize}, quality: ${qualityName})`,
          );
        } catch (err) {
          this.log.error(
            `Rescan[media #${mediaId}]: failed to save refreshed metadata for "${normPath}"`,
            err instanceof Error ? err.stack : err,
          );
        }
      }
    }

    // 5. Add new files found on disk but not in DB
    for (const absPath of diskFiles) {
      const relativePath = relativePathUnderMediaRoot(mediaDir, absPath);
      if (!relativePath) {
        this.log.error(
          `Rescan[media #${mediaId}]: internal inconsistency — file was listed but not under mediaDir — mediaDir="${mediaDir}" file="${absPath}"`,
        );
        continue;
      }
      if (dbRelPaths.has(relativePath)) continue;

      let size = 0;
      try {
        size = fs.statSync(absPath).size;
      } catch (err) {
        this.log.error(
          `Rescan[media #${mediaId}]: cannot stat new file — path="${absPath}"`,
          err instanceof Error ? err.stack : err,
        );
        continue;
      }

      const filename = path.basename(absPath);

      // Try to match episode for series — create season/episode on the fly if missing
      let episodeId: number | undefined;
      if (media.type === MediaType.SERIES) {
        const epNums = this.parseEpisodeNumbers(filename);
        if (epNums) {
          try {
            let season = await this.seasonRepo.findOne({
              where: { mediaId: media.id, seasonNumber: epNums.season },
            });
            if (!season) {
              season = await this.seasonRepo.save(
                this.seasonRepo.create({
                  mediaId: media.id,
                  seasonNumber: epNums.season,
                  monitored: true,
                }),
              );
              this.log.log(
                `Rescan: created season ${epNums.season} for media #${mediaId}`,
              );
            }
            let ep = await this.episodeRepo.findOne({
              where: { seasonId: season.id, episodeNumber: epNums.episode },
            });
            if (!ep) {
              ep = await this.episodeRepo.save(
                this.episodeRepo.create({
                  seasonId: season.id,
                  episodeNumber: epNums.episode,
                  monitored: true,
                }),
              );
              this.log.log(
                `Rescan: created episode S${String(epNums.season).padStart(2, '0')}E${String(epNums.episode).padStart(2, '0')} for media #${mediaId}`,
              );
            }
            episodeId = ep.id;
          } catch (err) {
            this.log.error(
              `Rescan[media #${mediaId}]: failed to create season/episode for new file "${filename}" — importing file without episode link`,
              err instanceof Error ? err.stack : err,
            );
          }
        } else {
          this.log.warn(
            `Rescan[media #${mediaId}]: series file name has no SxxEyy pattern — "${filename}" (file will not link to an episode)`,
          );
        }
      }

      let streamInfo: Awaited<
        ReturnType<FfprobeService['detectMediaFileInfo']>
      >;
      try {
        streamInfo = await this.ffprobe.detectMediaFileInfo(absPath);
        if (streamInfo?.video?.[0]) {
          try {
            const crop = await this.ffprobe.detectCrop(
              absPath,
              streamInfo.durationSeconds,
            );
            if (crop) streamInfo.video[0].crop = crop;
          } catch (err) {
            this.log.warn(
              `Rescan[media #${mediaId}]: detectCrop failed for "${relativePath}" abs="${absPath}" (file still imported)`,
              err instanceof Error ? err.stack : err,
            );
          }
        }
      } catch (err) {
        this.log.error(
          `Rescan[media #${mediaId}]: ffprobe failed for new file "${relativePath}" abs="${absPath}"`,
          err instanceof Error ? err.stack : err,
        );
        continue;
      }
      const qualityName = this.resolveQuality(
        filename,
        streamInfo.video?.[0]?.height,
        streamInfo.video?.[0]?.width,
      );
      try {
        await this.mediaFileRepo.save(
          this.mediaFileRepo.create({
            mediaId: media.id,
            episodeId,
            relativePath,
            size,
            quality: qualityName,
            streamInfo,
          }),
        );
        added++;
        this.log.log(
          `Rescan: added new file "${relativePath}" for media #${mediaId}`,
        );
        if (episodeId != null) {
          await this.episodeRepo.update(episodeId, { hasFile: true });
        }
      } catch (err) {
        this.log.error(
          `Rescan[media #${mediaId}]: failed to save new file row "${relativePath}" abs="${absPath}"`,
          err instanceof Error ? err.stack : err,
        );
      }
    }

    this.log.log(
      `Rescan: finished — media #${mediaId} "${media.title}" added=${added} removed=${removed} updated=${updated}`,
    );
    if (added === 0 && removed === 0 && updated === 0) {
      this.log.warn(
        `Rescan[media #${mediaId}]: no changes (added=0 removed=0 updated=0)`,
      );
    }

    if (added || removed || updated) {
      void this.mediaServers.dispatch('library.rescan', {
        title: media.title,
        path: media.path,
      });
    }

    return { added, removed, updated };
  }

  private collectVideoFilesRecursive(
    dir: string,
    depth: number,
    mediaId: number,
  ): string[] {
    if (depth > 3) {
      this.log.warn(
        `Rescan[media #${mediaId}]: skipping subfolder (max depth 3) — "${dir}"`,
      );
      return [];
    }
    const files: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      this.log.error(
        `Rescan[media #${mediaId}]: cannot read directory (permissions, missing path, or I/O) — "${dir}"`,
        err instanceof Error ? err.stack : err,
      );
      return [];
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(
          ...this.collectVideoFilesRecursive(fullPath, depth + 1, mediaId),
        );
      } else if (
        MediaService.VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())
      ) {
        files.push(fullPath);
      }
    }
    return files;
  }

  private parseEpisodeNumbers(
    filename: string,
  ): { season: number; episode: number } | null {
    const m = filename.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
    if (!m) return null;
    return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  }

  /**
   * Determine quality from ffprobe resolution (source of truth) + filename source tag.
   */
  private resolveQuality(
    filename: string,
    actualHeight?: number,
    actualWidth?: number,
  ): string {
    // Use width to determine resolution (stable across aspect ratios, like Jellyfin)
    let resolution: number;
    if (actualWidth && actualWidth >= 3800) resolution = 2160;
    else if (actualWidth && actualWidth >= 1900) resolution = 1080;
    else if (actualWidth && actualWidth >= 1260) resolution = 720;
    else resolution = 480;

    // Determine source from filename (bluray, web, remux, etc.)
    const t = filename.replace(/\./g, ' ').toLowerCase();
    let source = 'hdtv';
    if (/\bremux\b/.test(t)) source = 'remux';
    else if (/\b(bluray|blu-?ray|bdrip|brrip)\b/.test(t)) source = 'bluray';
    else if (/\bweb-?dl\b/.test(t)) source = 'web';
    else if (/\bweb-?rip\b/.test(t)) source = 'web';
    else if (/\b(dvd|dvdrip)\b/.test(t)) source = 'dvd';

    const match = APP_QUALITIES.find(
      (q) => q.resolution === resolution && q.source === source,
    );
    if (match) return match.name;

    // Fallback: any quality with correct resolution
    const fallback = APP_QUALITIES.find((q) => q.resolution === resolution);
    return fallback?.name ?? `HDTV-${resolution}p`;
  }
}
