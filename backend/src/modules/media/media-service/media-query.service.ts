import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { Media } from '../entities/media.entity';
import { Season } from '../entities/season.entity';
import { Episode } from '../entities/episode.entity';
import { MediaType } from '../../../common/enums';

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
  ) {}

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
      // Specials (season 0) sort last: an appendix, not the opening season.
      const rank = (n: number) => (n === 0 ? Number.MAX_SAFE_INTEGER : n);
      media.seasons.sort((a, b) => rank(a.seasonNumber) - rank(b.seasonNumber));
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

}
