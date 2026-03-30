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
import { CalendarQueryDto } from './dto/calendar-query.dto';
import { HistoryQueryDto } from './dto/history-query.dto';
import { TmdbProvider } from '../metadata-providers/providers/tmdb.provider';
import { MetadataDetails, SeasonDetails } from '../metadata-providers/interfaces/metadata-provider.interface';
import { MediaType, MediaStatus } from '../../common/enums';
import { ProfilesService } from '../profiles/profiles.service';
import { RootFolder } from '../root-folders/entities/root-folder.entity';

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

    let rootPath: string | undefined;
    if (dto.rootFolderId) {
      const rf = await this.rootFolderRepo.findOne({ where: { id: dto.rootFolderId } });
      if (rf) rootPath = rf.path;
    }

    if (dto.type === MediaType.MOVIE) {
      const details = await this.tmdb.getMovieDetails(dto.tmdbId);
      return this.persistImportedMovie(details, qualityProfileId, rootPath);
    }

    const details = await this.tmdb.getTvShowDetails(dto.tmdbId);
    const seasons = await this.tmdb.getTvShowSeasons(dto.tmdbId);
    return this.persistImportedSeries(details, seasons, qualityProfileId, rootPath);
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

  async findAll(query: SearchMediaDto): Promise<{ data: Media[]; total: number }> {
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
    qb.orderBy(
      sortBy.includes('.') ? sortBy : `media.${sortBy}`,
      sortOrder,
    );

    qb.skip(offset).take(limit);

    const [data, total] = await qb.getManyAndCount();

    // For series: attach episode stats
    const seriesIds = data.filter((m) => m.type === 'series').map((m) => m.id);
    let episodeStatsMap = new Map<number, { totalEpisodes: number; downloadedEpisodes: number }>();
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
          { totalEpisodes: parseInt(s.total, 10), downloadedEpisodes: parseInt(s.downloaded, 10) },
        ]),
      );
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
    return media;
  }

  async update(id: number, dto: UpdateMediaDto): Promise<Media> {
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

  async updatePath(id: number, path: string): Promise<Media> {
    await this.findOne(id);
    await this.mediaRepo.update(id, { path });
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

  async remove(id: number): Promise<void> {
    const media = await this.findOne(id);
    await this.mediaRepo.remove(media);
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
      return String(v).slice(0, 10);
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
              .orWhere('m.digitalRelease BETWEEN :start AND :end', { start, end })
              .orWhere('m.physicalRelease BETWEEN :start AND :end', { start, end })
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

  async getHistory(
    dto: HistoryQueryDto,
  ): Promise<{ data: Record<string, unknown>[]; total: number }> {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 25;

    const where: Record<string, unknown> = {};
    if (dto.mediaId) where.mediaId = dto.mediaId;

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

  async retryImport(historyId: number): Promise<void> {
    const entry = await this.historyRepo.findOne({ where: { id: historyId } });
    if (!entry) return;
    await this.historyRepo.update(historyId, { status: 'grabbed' });
  }

  async linkTorrentToMedia(
    mediaId: number,
    sourceTitle: string,
    clientId?: number,
  ): Promise<DownloadHistory> {
    await this.findOne(mediaId);
    return this.historyRepo.save(
      this.historyRepo.create({
        mediaId,
        sourceTitle,
        downloadClientId: clientId ?? undefined,
        quality: this.parseQuality(sourceTitle),
        status: 'grabbed',
      }),
    );
  }

  private parseQuality(title: string): string {
    const u = title.toUpperCase();
    if (u.includes('2160P') || u.includes('4K') || u.includes('UHD')) return '2160p';
    if (u.includes('1080P')) return '1080p';
    if (u.includes('720P')) return '720p';
    if (u.includes('480P')) return '480p';
    if (u.includes('REMUX')) return 'Remux';
    if (u.includes('BLURAY') || u.includes('BLU-RAY')) return 'Bluray';
    if (u.includes('WEBRIP')) return 'WEBRip';
    if (u.includes('WEB-DL') || u.includes('WEBDL')) return 'WEB-DL';
    if (u.includes('WEB')) return 'WEB';
    if (u.includes('HDTV')) return 'HDTV';
    return '';
  }

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

  async deleteMediaFile(mediaId: number, fileId: number, deleteOnDisk: boolean): Promise<void> {
    const media = await this.mediaRepo.findOne({ where: { id: mediaId } });
    if (!media) throw new NotFoundException(`Media #${mediaId} not found`);

    const file = await this.mediaFileRepo.findOne({ where: { id: fileId, mediaId } });
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

    await this.mediaFileRepo.remove(file);
  }

  async deleteHistoryEntry(id: number): Promise<void> {
    const entry = await this.historyRepo.findOne({ where: { id } });
    if (!entry) throw new NotFoundException(`History entry #${id} not found`);
    await this.historyRepo.remove(entry);
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
          if (ep.overview && ep.overview !== existing.overview) updates.overview = ep.overview;
          if (ep.airDate && ep.airDate !== existing.airDate) updates.airDate = ep.airDate;
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

  private async persistImportedMovie(
    details: MetadataDetails,
    qualityProfileId: number | null,
    rootPath?: string,
  ): Promise<Media> {
    const row = this.mediaRepo.create({
      ...this.buildMediaFieldsFromTmdb(details, MediaType.MOVIE),
      ...(qualityProfileId != null ? { qualityProfileId } : {}),
      ...(rootPath ? { path: rootPath } : {}),
    });
    const saved = await this.mediaRepo.save(row);
    await this.updateSearchVector(saved.id);
    return this.findOne(saved.id);
  }

  private async persistImportedSeries(
    details: MetadataDetails,
    seasons: SeasonDetails[],
    qualityProfileId: number | null,
    rootPath?: string,
  ): Promise<Media> {
    const row = this.mediaRepo.create({
      ...this.buildMediaFieldsFromTmdb(details, MediaType.SERIES),
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
        await this.episodeRepo.insert(
          sd.episodes.map((ep) => ({
            seasonId: sSaved.id,
            episodeNumber: ep.episodeNumber,
            title: ep.title || undefined,
            overview: ep.overview || undefined,
            airDate: ep.airDate || undefined,
            monitored: true,
          })),
        );
      }
    }

    await this.updateSearchVector(saved.id);
    return this.findOne(saved.id);
  }
}
