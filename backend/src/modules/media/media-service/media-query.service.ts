import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, Repository, SelectQueryBuilder } from 'typeorm';
import { Media } from '../entities/media.entity';
import { Season } from '../entities/season.entity';
import { Episode } from '../entities/episode.entity';
import { MediaCast } from '../entities/media-cast.entity';
import { MediaCrew } from '../entities/media-crew.entity';
import { SearchMediaDto } from '../dto/search-media.dto';
import { CalendarQueryDto } from '../dto/calendar-query.dto';
import { MediaType } from '../../../common/enums';
import {
  getAppQualityById,
  AppQualityDefinition,
} from '../../../common/constants/app-qualities';
import { rankFromQualityString } from '../release-rejection.helper';
import { parseReleaseQuality } from '../../../common/release-parsing';
import { onDiskSql, shadowedEpisodeNumbers } from '../episode-coverage.util';

export type CutoffState =
  | 'unmonitored'
  | 'no-profile'
  | 'missing'
  | 'below'
  | 'met';

export interface TrackingItemState {
  monitored: boolean;
  state: CutoffState;
  /** Resolution label of the best file on disk (e.g. "1080p"), when present. */
  currentQuality?: string;
  /** Profile cutoff label (e.g. "2160p"), set when state is `below`. */
  targetQuality?: string;
}

export interface TrackingEpisode extends TrackingItemState {
  episodeId: number;
  seasonNumber: number;
  episodeNumber: number;
  /** Last episode number when this row is a multi-episode file (else null). */
  endEpisodeNumber: number | null;
  title: string | null;
}

export interface TrackingStatus {
  type: MediaType;
  hasProfile: boolean;
  /** Movie only. */
  movie?: TrackingItemState;
  /** Series only. */
  seasons?: { seasonNumber: number; episodes: TrackingEpisode[] }[];
}

/**
 * Subquery returning every media.id that the user (`:userId` bind) has
 * finished. Used by both `excludeWatched` (NOT IN …) and `onlyWatched`
 * (IN …) in `findAll`.
 *
 * - Movies: any completed playback for that media counts as watched.
 * - Series: watched only when every episode with a file (specials, season 0,
 *   excluded) has a completed playback row for this user. A series with no
 *   downloaded episodes never qualifies as watched.
 */
const WATCHED_MEDIA_IDS_SUBQUERY = `
  SELECT DISTINCT ps."mediaId" AS id FROM playback_states ps
  INNER JOIN media m ON m.id = ps."mediaId"
  WHERE ps."userId" = :userId AND ps.completed = true AND m.type = 'movie'
  UNION
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
      SELECT 1 FROM playback_states ps2
      WHERE ps2."userId" = :userId AND ps2."episodeId" = e.id AND ps2.completed = true
    )
  )
`;

@Injectable()
export class MediaQueryService {
  private readonly log = new Logger(MediaQueryService.name);

  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(Season)
    private readonly seasonRepo: Repository<Season>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(MediaCast)
    private readonly castRepo: Repository<MediaCast>,
    @InjectRepository(MediaCrew)
    private readonly crewRepo: Repository<MediaCrew>,
    private readonly dataSource: DataSource,
  ) {}

  async getCounts(
    accessibleLibraryIds: number[],
  ): Promise<{ movies: number; series: number }> {
    const buildQb = (type: MediaType) => {
      const qb = this.mediaRepo
        .createQueryBuilder('media')
        .where('media.type = :type', { type });
      this.applyLibraryAcl(qb, accessibleLibraryIds);
      return qb;
    };
    const [movies, series] = await Promise.all([
      buildQb(MediaType.MOVIE).getCount(),
      buildQb(MediaType.SERIES).getCount(),
    ]);
    return { movies, series };
  }

  async getCountsByLibrary(
    accessibleLibraryIds: number[],
  ): Promise<Record<number, number>> {
    const qb = this.mediaRepo
      .createQueryBuilder('m')
      .select('m."libraryId"', 'libraryId')
      .addSelect('COUNT(*)::int', 'count')
      .where('m."libraryId" IS NOT NULL')
      .groupBy('m."libraryId"');
    this.applyLibraryAcl(qb, accessibleLibraryIds);
    const rows: { libraryId: number; count: number }[] = await qb.getRawMany();
    return Object.fromEntries(rows.map((r) => [r.libraryId, r.count]));
  }

  /**
   * Aggregate distinct genres across the accessible libraries, with the
   * total item count + up to 4 sample posters per genre (used by the
   * library Genres tab to render a mosaic when posters are available).
   * Skips media with null / empty `posterUrl` for the sample collection
   * — they wouldn't render anything useful in the mosaic.
   */
  async getGenres(
    accessibleLibraryIds: number[],
  ): Promise<{ genre: string; count: number; posters: string[] }[]> {
    if (accessibleLibraryIds.length === 0) return [];
    const rows: { genre: string; count: number; posters: string[] }[] =
      await this.mediaRepo.query(
        `
        SELECT g.genre,
               COUNT(*)::int AS count,
               COALESCE(
                 (ARRAY_AGG(m."posterUrl" ORDER BY m.id)
                  FILTER (WHERE m."posterUrl" IS NOT NULL))[1:4],
                 ARRAY[]::text[]
               ) AS posters
        FROM media m
        CROSS JOIN LATERAL jsonb_array_elements_text(m.genres) AS g(genre)
        WHERE m."libraryId" = ANY($1)
          AND m.genres IS NOT NULL
          AND m.genres::text != '[]'
        GROUP BY g.genre
        ORDER BY g.genre ASC
        `,
        [accessibleLibraryIds],
      );
    return rows;
  }

  async getCollections(
    accessibleLibraryIds: number[],
  ): Promise<{ id: number; name: string; count: number; posters: string[] }[]> {
    if (accessibleLibraryIds.length === 0) return [];
    const rows: {
      id: number;
      name: string;
      count: number;
      posters: string[];
    }[] = await this.mediaRepo.query(
      `
        SELECT m."tmdbCollectionId"   AS id,
               m."tmdbCollectionName" AS name,
               COUNT(*)::int          AS count,
               COALESCE(
                 (ARRAY_AGG(m."posterUrl" ORDER BY m.id)
                  FILTER (WHERE m."posterUrl" IS NOT NULL))[1:4],
                 ARRAY[]::text[]
               ) AS posters
        FROM media m
        WHERE m."libraryId" = ANY($1)
          AND m."tmdbCollectionId" IS NOT NULL
          AND m."tmdbCollectionName" IS NOT NULL
        GROUP BY m."tmdbCollectionId", m."tmdbCollectionName"
        HAVING COUNT(*) >= 2
        ORDER BY m."tmdbCollectionName" ASC
        `,
      [accessibleLibraryIds],
    );
    return rows;
  }

  async findAll(
    query: SearchMediaDto,
    userId?: number,
    accessibleLibraryIds: number[] = [],
  ): Promise<{ data: Media[]; total: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const offset = (page - 1) * limit;

    const qb = this.mediaRepo
      .createQueryBuilder('media')
      .leftJoinAndSelect('media.library', 'library')
      .leftJoinAndSelect('media.qualityProfile', 'qualityProfile')
      .leftJoinAndSelect('media.languageProfile', 'languageProfile')
      .leftJoinAndSelect('media.files', 'files');

    this.applyLibraryAcl(qb, accessibleLibraryIds);
    this.applyFilters(qb, query);

    if ((query.excludeWatched || query.onlyWatched) && userId) {
      const op = query.onlyWatched ? 'IN' : 'NOT IN';
      qb.andWhere(`media.id ${op} (${WATCHED_MEDIA_IDS_SUBQUERY})`, { userId });
    }

    if (query.requestedByMe && userId) {
      // Approved requests set `media.addedById` to the requester, and direct
      // imports set it to the importer — so a single column lookup covers
      // both flows.
      qb.andWhere('media."addedById" = :reqUserId', { reqUserId: userId });
    }

    if (query.q) {
      this.applyFullTextSearch(qb, query.q);
    }

    // Whitelist + column mapping for ORDER BY. The raw `sortBy` value
    // arrives from the client, so we must reject anything outside the
    // allowed keys (otherwise the string ends up concatenated into the
    // SQL — classic ORDER BY injection vector) and translate UI-side
    // aliases like `added` to the actual physical column (`createdAt`,
    // inherited from BaseEntity).
    const SORT_BY_MAP: Record<string, string> = {
      title: 'media.title',
      year: 'media.year',
      added: 'media.createdAt',
      createdAt: 'media.createdAt',
      rating: 'media.rating',
    };
    const sortBy = SORT_BY_MAP[query.sortBy ?? 'title'] ?? 'media.title';
    const sortOrder = query.sortOrder === 'DESC' ? 'DESC' : 'ASC';
    qb.orderBy(sortBy, sortOrder);

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
          // "downloaded" = episodes whose content is on disk (coverage),
          // including the shadowed episodes of a multi-episode file. Counting
          // MediaFile rows or hasFile alone would undercount those.
          `SELECT s."mediaId",
                  COUNT(e.id) AS total,
                  COUNT(e.id) FILTER (WHERE ${onDiskSql('e')}) AS downloaded
           FROM seasons s
           JOIN episodes e ON e."seasonId" = s.id
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
      // Cutoff comparison must reach below the cutoff *on the unit that gets
      // downloaded* — the whole movie for movies, each individual episode
      // for series. Movies use `media.files[]`; series fold "totally missing"
      // entries (no file → rank 0) into this bucket and lean on
      // `parseReleaseQuality` (via {@link rankFromQualityString}) so legacy
      // stored quality strings are parsed instead of needing an exact
      // `APP_QUALITIES.name` match.
      const cutoffByMedia = new Map<number, number>();
      for (const m of enriched) {
        if (!m.qualityProfile) continue;
        const cq = getAppQualityById(m.qualityProfile.cutoff);
        if (cq) cutoffByMedia.set(m.id, cq.rank);
      }
      const seriesIds = enriched
        .filter((m) => m.type === MediaType.SERIES && cutoffByMedia.has(m.id))
        .map((m) => m.id);
      // Per (media, season) → best file rank per monitored episode, plus the
      // season's shadowed episode numbers. A shadowed episode (covered by a
      // multi-episode file's range) has no file of its own, so evaluating it
      // would falsely read rank 0; we skip it and rely on its owner — matching
      // the tracking modal which hides shadowed episodes.
      const epInfoByMedia = new Map<
        number,
        Map<
          number,
          {
            episodeNumber: number;
            endEpisodeNumber: number | null;
            rank: number;
          }
        >
      >();
      if (seriesIds.length) {
        const epRows: {
          mediaId: number;
          epId: number;
          episodeNumber: number;
          endEpisodeNumber: number | null;
          quality: string | null;
        }[] = await this.dataSource.query(
          `SELECT s."mediaId" AS "mediaId",
                  e.id      AS "epId",
                  e."episodeNumber" AS "episodeNumber",
                  e."endEpisodeNumber" AS "endEpisodeNumber",
                  f."quality" AS "quality"
             FROM seasons s
             JOIN episodes e ON e."seasonId" = s.id
             LEFT JOIN media_files f ON f."episodeId" = e.id
            WHERE s."mediaId" = ANY($1)
              AND s."seasonNumber" > 0
              AND e.monitored = true`,
          [seriesIds],
        );
        for (const row of epRows) {
          let byEp = epInfoByMedia.get(row.mediaId);
          if (!byEp) {
            byEp = new Map();
            epInfoByMedia.set(row.mediaId, byEp);
          }
          const rank = rankFromQualityString(row.quality);
          const prev = byEp.get(row.epId);
          if (prev) {
            if (rank > prev.rank) prev.rank = rank;
          } else {
            byEp.set(row.epId, {
              episodeNumber: row.episodeNumber,
              endEpisodeNumber: row.endEpisodeNumber,
              rank,
            });
          }
        }
      }
      enriched = enriched.filter((m) => {
        const cutoffRank = cutoffByMedia.get(m.id);
        if (cutoffRank == null) return false;
        if (m.type === MediaType.MOVIE) {
          let rank = 0;
          for (const f of m.files ?? []) {
            const r = rankFromQualityString(f.quality);
            if (r > rank) rank = r;
          }
          return rank < cutoffRank;
        }
        const byEp = epInfoByMedia.get(m.id);
        if (!byEp || byEp.size === 0) return false;
        const eps = [...byEp.values()];
        const shadowed = shadowedEpisodeNumbers(eps);
        for (const ep of eps) {
          if (shadowed.has(ep.episodeNumber)) continue;
          if (ep.rank < cutoffRank) return true;
        }
        return false;
      });
    }

    return { data: enriched, total };
  }

  /** When `accessibleLibraryIds` is omitted the lookup is unscoped — used
   *  by internal callers (admin approve path, schedulers) that have
   *  already validated access. Controllers must pass the user's library
   *  set so the result respects the ACL. */
  async findByTmdbId(
    tmdbId: number,
    type: MediaType,
    accessibleLibraryIds?: number[],
  ): Promise<Media | null> {
    const m = await this.mediaRepo.findOne({ where: { tmdbId, type } });
    if (!m) return null;
    if (accessibleLibraryIds) {
      if (m.libraryId == null || !accessibleLibraryIds.includes(m.libraryId)) {
        return null;
      }
    }
    return m;
  }

  /**
   * Throws NotFoundException when the media exists but is outside the user's
   * accessible libraries — same shape as "not found" so we don't leak existence.
   */
  async assertAccessible(
    mediaId: number,
    accessibleLibraryIds: number[],
  ): Promise<void> {
    // `libraryId` is a @RelationId virtual — TypeORM's findOne + select
    // can't project it. Use a raw query on the join column instead.
    const row = await this.mediaRepo
      .createQueryBuilder('m')
      .select('m."libraryId"', 'libraryId')
      .where('m.id = :mediaId', { mediaId })
      .getRawOne<{ libraryId: number | null }>();
    if (!row) throw new NotFoundException(`Media #${mediaId} not found`);
    if (
      row.libraryId == null ||
      !accessibleLibraryIds.includes(row.libraryId)
    ) {
      throw new NotFoundException(`Media #${mediaId} not found`);
    }
  }

  /** Returns the parent media id for a season — used by ACL on season-scoped endpoints. */
  async getMediaIdForSeason(seasonId: number): Promise<number> {
    const s = await this.seasonRepo.findOne({ where: { id: seasonId } });
    if (!s) throw new NotFoundException(`Season #${seasonId} not found`);
    return s.mediaId;
  }

  /** Returns the parent media id for an episode — used by ACL on episode-scoped endpoints. */
  async getMediaIdForEpisode(episodeId: number): Promise<number> {
    const e = await this.episodeRepo.findOne({
      where: { id: episodeId },
      relations: ['season'],
    });
    if (!e) throw new NotFoundException(`Episode #${episodeId} not found`);
    return e.season.mediaId;
  }

  async getCast(mediaId: number): Promise<MediaCast[]> {
    return this.castRepo.find({
      where: { media: { id: mediaId } },
      relations: ['person'],
      order: { order: 'ASC' },
    });
  }

  async getCrew(mediaId: number): Promise<MediaCrew[]> {
    return this.crewRepo.find({
      where: { media: { id: mediaId } },
      relations: ['person'],
    });
  }

  async findOne(id: number): Promise<Media> {
    // relationLoadStrategy 'query' issues one SELECT per relation instead of
    // a single LEFT JOIN — without it, a series with 200 episodes × 200 files
    // × N tags hydrates the cartesian-product (40k+ rows) and the endpoint
    // takes ~4 s. With separate queries each relation is bounded and the
    // total drops to a few hundred ms.
    const media = await this.mediaRepo.findOne({
      where: { id },
      relationLoadStrategy: 'query',
      relations: [
        'seasons',
        'seasons.episodes',
        'files',
        'qualityProfile',
        'languageProfile',
        'library',
        // Eager on the entity, but relationLoadStrategy 'query' above
        // skips eager auto-load — list it explicitly so the detail
        // endpoint exposes the extended TMDB fields (originalLanguage,
        // productionCountries, productionCompanies, tagline, …).
        'metadata',
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
      // In-memory heal of own-file hasFile from the loaded files (coverage is
      // derived on read via episode-coverage.util, not stored here).
      for (const s of media.seasons) {
        for (const e of s.episodes ?? []) {
          if (epIdsWithTrackedFile.has(e.id)) e.hasFile = true;
        }
      }
    }
    return media;
  }

  /**
   * Per-item monitoring + cutoff state for the "tracking status" modal.
   * Movie → a single state; series → every episode grouped by season (each
   * episode keeps its own state so the UI can show "not monitored", "cutoff
   * met", or the reason it isn't: missing / below cutoff / no profile).
   */
  async getTrackingStatus(id: number): Promise<TrackingStatus> {
    const media = await this.findOne(id);
    const profile = media.qualityProfile;
    const cutoffDef = profile ? getAppQualityById(profile.cutoff) : undefined;
    const targetQuality = cutoffDef ? this.qualityLabel(cutoffDef) : null;

    const stateOf = (
      monitored: boolean,
      files: { quality: string }[],
    ): TrackingItemState => {
      if (!monitored) return { monitored, state: 'unmonitored' };
      if (!cutoffDef) return { monitored, state: 'no-profile' };
      if (!files.length) return { monitored, state: 'missing' };
      let best: AppQualityDefinition | undefined;
      for (const f of files) {
        const def = parseReleaseQuality(f.quality).quality;
        if (!best || def.rank > best.rank) best = def;
      }
      if (best && best.rank >= cutoffDef.rank) {
        return {
          monitored,
          state: 'met',
          currentQuality: this.qualityLabel(best),
        };
      }
      // Same resolution but a lower-ranked source (e.g. HDTV-2160p vs the
      // Bluray-2160p cutoff) would render as "2160p → 2160p" and look like a
      // bug — fall back to the full quality names when resolutions collide so
      // the actual gap is visible.
      const sameResolution = !!best && best.resolution === cutoffDef.resolution;
      return {
        monitored,
        state: 'below',
        currentQuality: best
          ? sameResolution
            ? best.name
            : this.qualityLabel(best)
          : undefined,
        targetQuality: sameResolution
          ? cutoffDef.name
          : (targetQuality ?? undefined),
      };
    };

    if (media.type === MediaType.MOVIE) {
      return {
        type: media.type,
        hasProfile: !!profile,
        movie: stateOf(media.monitored, media.files ?? []),
      };
    }

    // The multi-episode file is linked to its owner episode (E17); the shadowed
    // episodes (E18) are hidden below, so mapping each file to its owner is
    // enough to render the owner's state.
    const filesByEpisode = new Map<number, { quality: string }[]>();
    for (const f of media.files ?? []) {
      if (f.episodeId == null) continue;
      const list = filesByEpisode.get(f.episodeId) ?? [];
      list.push({ quality: f.quality });
      filesByEpisode.set(f.episodeId, list);
    }

    const seasons = (media.seasons ?? []).map((s) => {
      // Hide shadowed episodes (covered by another episode's range) and label
      // the owner with its range — same convention as the episode grid.
      const shadowed = new Set<number>();
      for (const e of s.episodes ?? []) {
        if (
          e.endEpisodeNumber != null &&
          e.endEpisodeNumber > e.episodeNumber
        ) {
          for (let n = e.episodeNumber + 1; n <= e.endEpisodeNumber; n++) {
            shadowed.add(n);
          }
        }
      }
      return {
        seasonNumber: s.seasonNumber,
        episodes: (s.episodes ?? [])
          .filter((e) => !shadowed.has(e.episodeNumber))
          .map((e) => ({
            episodeId: e.id,
            seasonNumber: s.seasonNumber,
            episodeNumber: e.episodeNumber,
            endEpisodeNumber: e.endEpisodeNumber ?? null,
            title: e.title,
            ...stateOf(e.monitored, filesByEpisode.get(e.id) ?? []),
          })),
      };
    });

    return { type: media.type, hasProfile: !!profile, seasons };
  }

  private qualityLabel(def: AppQualityDefinition): string {
    return def.resolution > 0 ? `${def.resolution}p` : def.name;
  }

  async getCalendar(
    dto: CalendarQueryDto,
    accessibleLibraryIds: number[],
    userId?: number,
  ) {
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
      const moviesQb = this.mediaRepo
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
        );
      if (dto.monitoredOnly) {
        moviesQb.andWhere('m.monitored = true');
      }
      if (dto.requestedByMe && userId) {
        moviesQb.andWhere('m."addedById" = :calUserId', { calUserId: userId });
      }
      if (accessibleLibraryIds.length === 0) {
        moviesQb.andWhere('1 = 0');
      } else {
        moviesQb.andWhere('m.libraryId IN (:...accessibleLibraryIds)', {
          accessibleLibraryIds,
        });
      }
      const movies = await moviesQb.getMany();

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
      const epQb = this.episodeRepo
        .createQueryBuilder('ep')
        .innerJoinAndSelect('ep.season', 'season')
        .innerJoinAndSelect('season.media', 'media')
        .where('ep.airDate BETWEEN :start AND :end', { start, end })
        .orderBy('ep.airDate', 'ASC');
      if (dto.monitoredOnly) {
        epQb.andWhere('media.monitored = true').andWhere('ep.monitored = true');
      }
      if (dto.requestedByMe && userId) {
        epQb.andWhere('media."addedById" = :calUserId', { calUserId: userId });
      }
      if (accessibleLibraryIds.length === 0) {
        epQb.andWhere('1 = 0');
      } else {
        epQb.andWhere('media.libraryId IN (:...accessibleLibraryIds)', {
          accessibleLibraryIds,
        });
      }
      // Compute coverage (on disk) per episode so a shadowed multi-episode
      // entry shows as downloaded — derived in SQL, not stored.
      epQb.addSelect(onDiskSql('ep'), 'ep_onDisk');
      const { entities, raw } = await epQb.getRawAndEntities();
      const onDiskByEpId = new Map<number, boolean>();
      for (const r of raw as { ep_id: number; ep_onDisk: boolean }[]) {
        onDiskByEpId.set(r.ep_id, r.ep_onDisk);
      }

      for (const ep of entities) {
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
          // "downloaded" badge = content on disk (coverage).
          hasFile: onDiskByEpId.get(ep.id) ?? ep.hasFile,
        });
      }
    }

    results.sort((a, b) => a.date.localeCompare(b.date));
    return results;
  }

  /** Adds `WHERE <alias>.libraryId IN (...)` to scope a query to the
   *  caller's accessible libraries. Uses the query builder's own alias
   *  so it works whether the caller aliased the media table as "media"
   *  (default) or "m" (findAll / counts queries). An empty array short-
   *  circuits to `1 = 0` so the caller still hits a real WHERE and
   *  returns no rows. */
  private applyLibraryAcl(
    qb: SelectQueryBuilder<Media>,
    accessibleLibraryIds: number[],
  ): void {
    if (accessibleLibraryIds.length === 0) {
      qb.andWhere('1 = 0');
      return;
    }
    const alias = qb.alias;
    qb.andWhere(`${alias}."libraryId" IN (:...accessibleLibraryIds)`, {
      accessibleLibraryIds,
    });
  }

  private applyFilters(
    qb: SelectQueryBuilder<Media>,
    query: SearchMediaDto,
  ): void {
    if (query.libraryId) {
      qb.andWhere('media.libraryId = :libraryId', {
        libraryId: query.libraryId,
      });
    }
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
    if (query.collectionId) {
      qb.andWhere('media.tmdbCollectionId = :collectionId', {
        collectionId: query.collectionId,
      });
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
        OR similarity(media.title, :q) > 0.8
      )`,
      { q: searchTerm, like: `%${searchTerm}%` },
    );
    qb.orderBy('rank', 'DESC');
  }
}
