import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Media } from './entities/media.entity';
import { Season } from './entities/season.entity';
import { Episode } from './entities/episode.entity';
import { MediaCast } from './entities/media-cast.entity';
import { MediaCrew } from './entities/media-crew.entity';
import { CreateMediaDto } from './dto/create-media.dto';
import { UpdateMediaDto } from './dto/update-media.dto';
import { SearchMediaDto } from './dto/search-media.dto';
import { AnalyzeMediaDto } from './dto/analyze-media.dto';
import { ImportTmdbDto } from './dto/import-tmdb.dto';
import { ImportMediaDto } from './dto/import-media.dto';
import { UpdateMediaProfilesDto } from './dto/update-media-profiles.dto';
import { BulkUpdateMediaDto } from './dto/bulk-update-media.dto';
import { CalendarQueryDto } from './dto/calendar-query.dto';
import { MediaType } from '../../common/enums';
import { MediaImportService } from './media-service/media-import.service';
import { MediaMetadataService } from './media-service/media-metadata.service';
import { MediaQueryService } from './media-service/media-query.service';
import { MediaRelatedService } from './media-service/media-related.service';
import { MediaMutationService } from './media-service/media-mutation.service';
import { MediaRescanService } from './media-service/media-rescan.service';
import { EventsService } from '../scheduler/events.service';

/**
 * Façade in front of the media sub-services. External callers
 * (controllers, schedulers, other modules) only see this surface, so
 * the public method signatures here are load-bearing — changing them
 * means changing every importer.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    private readonly imports: MediaImportService,
    private readonly metadata: MediaMetadataService,
    private readonly query: MediaQueryService,
    private readonly related: MediaRelatedService,
    private readonly mutation: MediaMutationService,
    private readonly rescan: MediaRescanService,
    private readonly events: EventsService,
  ) {}

  // -- Imports ----------------------------------------------------------------

  importFromTmdb(
    dto: ImportTmdbDto,
    addedByUserId: number | null = null,
    monitoredSeasons: number[] | null = null,
  ) {
    return this.imports.importFromTmdb(dto, addedByUserId, monitoredSeasons);
  }

  /**
   * Resolve (and validate) the import target library for a media type, or throw
   * a clear BadRequestException — no default library, missing root path, or
   * type mismatch. Lets request approval fail loudly up front instead of
   * importing into the void from the out-of-band tail.
   */
  assertImportTarget(type: MediaType, libraryId?: number) {
    return this.imports.resolveImportTarget(type, { libraryId });
  }

  importMedia(dto: ImportMediaDto, addedByUserId: number | null = null) {
    return this.imports.importMedia(dto, addedByUserId);
  }

  create(dto: CreateMediaDto) {
    return this.imports.create(dto);
  }

  // -- Reads ------------------------------------------------------------------

  getCounts(accessibleLibraryIds: number[]) {
    return this.query.getCounts(accessibleLibraryIds);
  }

  getCountsByLibrary(accessibleLibraryIds: number[]) {
    return this.query.getCountsByLibrary(accessibleLibraryIds);
  }

  getGenres(accessibleLibraryIds: number[]) {
    return this.query.getGenres(accessibleLibraryIds);
  }

  getCollections(accessibleLibraryIds: number[]) {
    return this.query.getCollections(accessibleLibraryIds);
  }

  findAll(
    query: SearchMediaDto,
    userId?: number,
    accessibleLibraryIds: number[] = [],
  ) {
    return this.query.findAll(query, userId, accessibleLibraryIds);
  }

  findRecentlyAdded(opts: Parameters<MediaQueryService['findRecentlyAdded']>[0]) {
    return this.query.findRecentlyAdded(opts);
  }

  findByTmdbId(
    tmdbId: number,
    type: MediaType,
    accessibleLibraryIds?: number[],
  ) {
    return this.query.findByTmdbId(tmdbId, type, accessibleLibraryIds);
  }

  findOne(id: number) {
    return this.query.findOne(id);
  }

  findSimilar(id: number, limit?: number) {
    return this.related.findSimilar(id, limit);
  }

  findCollection(id: number) {
    return this.related.findCollection(id);
  }

  getTrackingStatus(id: number) {
    return this.query.getTrackingStatus(id);
  }

  getCast(mediaId: number): Promise<MediaCast[]> {
    return this.query.getCast(mediaId);
  }

  getCrew(mediaId: number): Promise<MediaCrew[]> {
    return this.query.getCrew(mediaId);
  }

  getMediaIdForSeason(seasonId: number) {
    return this.query.getMediaIdForSeason(seasonId);
  }

  getMediaIdForEpisode(episodeId: number) {
    return this.query.getMediaIdForEpisode(episodeId);
  }

  assertAccessible(mediaId: number, accessibleLibraryIds: number[]) {
    return this.query.assertAccessible(mediaId, accessibleLibraryIds);
  }

  getCalendar(
    dto: CalendarQueryDto,
    accessibleLibraryIds: number[],
    userId?: number,
  ) {
    return this.query.getCalendar(dto, accessibleLibraryIds, userId);
  }

  // -- Mutations --------------------------------------------------------------

  update(id: number, dto: UpdateMediaDto) {
    return this.mutation.update(id, dto);
  }

  updateLibrary(id: number, libraryId: number) {
    return this.mutation.updateLibrary(id, libraryId);
  }

  updateProfiles(id: number, dto: UpdateMediaProfilesDto) {
    return this.mutation.updateProfiles(id, dto);
  }

  bulkUpdate(dto: BulkUpdateMediaDto) {
    return this.mutation.bulkUpdate(dto);
  }

  remove(id: number) {
    return this.mutation.remove(id);
  }

  deleteMediaFolder(dir: string) {
    return this.mutation.deleteMediaFolder(dir);
  }

  updateSeason(
    seasonId: number,
    patch: { monitored?: boolean; preferredProvider?: 'tmdb' | 'tvdb' | null },
  ) {
    return this.mutation.updateSeason(seasonId, patch);
  }

  updateEpisodeMonitored(episodeId: number, monitored: boolean) {
    return this.mutation.updateEpisodeMonitored(episodeId, monitored);
  }

  deleteMediaFile(mediaId: number, fileId: number, deleteOnDisk: boolean) {
    return this.mutation.deleteMediaFile(mediaId, fileId, deleteOnDisk);
  }

  // -- Metadata ---------------------------------------------------------------

  identify(
    id: number,
    target: {
      tmdbId?: number;
      tvdbId?: number;
      imdbId?: string;
      preferredProvider?: string;
    },
  ) {
    return this.metadata.applyIdentity(id, target);
  }

  /**
   * The provider half of an identification, plus the relink it needs: dropping
   * the old work's episodes leaves their files with no episode (`ON DELETE SET
   * NULL`), so the new work's episodes read as missing while the files sit on
   * disk. The rescan re-parses those filenames against the new numbering, and
   * only then is it safe to let the auto-grab pipeline look at this media.
   */
  async finishIdentify(id: number) {
    const media = await this.metadata.completeIdentify(id);
    try {
      await this.rescan.rescanFiles(id);
    } catch (err) {
      // A media with no root path has nothing to relink; anything else is worth
      // seeing, but neither is a reason to leave the identification unfinished.
      this.logger.warn(
        `identify: media#${id} relink skipped — ${(err as Error).message}`,
      );
    }
    this.events.emitDomain({
      type: 'media.acquisition.requested',
      mediaIds: [id],
      reason: 'metadata-refresh',
    });
    return media;
  }

  refreshMetadata(id: number) {
    return this.metadata.refreshMetadata(id);
  }

  async refreshEpisodeMetadata(mediaId: number, episodeId: number) {
    await this.metadata.refreshEpisodeMetadata(mediaId, episodeId);
    return this.query.findOne(mediaId);
  }

  // -- Rescan + analyse + file enrichment -------------------------------------

  rescanFiles(mediaId: number, options?: { skipWarmup?: boolean }) {
    return this.rescan.rescanFiles(mediaId, options);
  }

  analyzeMedia(mediaId: number, opts: AnalyzeMediaDto) {
    return this.rescan.analyzeMedia(mediaId, opts);
  }

  enrichMediaFileFromDisk(mediaFileId: number) {
    return this.rescan.enrichMediaFileFromDisk(mediaFileId);
  }

  linkExistingFileInPlace(p: {
    media: import('./entities/media.entity').Media;
    absPath: string;
    epNums?: {
      season: number;
      episode: number;
      episodeEnd?: number | null;
    } | null;
  }) {
    return this.rescan.linkExistingFileInPlace(p);
  }

  ensureSeriesEpisode(
    media: import('./entities/media.entity').Media,
    epNums: { season: number; episode: number; episodeEnd?: number | null },
  ) {
    return this.rescan.ensureSeriesEpisode(media, epNums);
  }

  // -- Request-driven lookups -------------------------------------------------

  /**
   * Load a media row with the relations the lifecycle needs to compute
   * coverage (`files`, `seasons`, `seasons.episodes`). Centralised here
   * to keep `mediaRepo.findOne` calls in one place.
   */
  findOneWithSeasonsAndFiles(mediaId: number): Promise<Media | null> {
    return this.mediaRepo.findOne({
      where: { id: mediaId },
      relations: ['files', 'seasons', 'seasons.episodes'],
    });
  }

  /**
   * Ensure the request scope is monitored after a request transitions
   * to APPROVED. Idempotent: only ever flips false → true, never the
   * other way around — admins keep control over what's unmonitored.
   *
   *  - Movies / whole-series requests (`seasons` empty/null): flip
   *    `media.monitored` if it was off.
   *  - Per-season series requests: flip `media.monitored` AND each
   *    listed `season.monitored`. Seasons not in the list are left
   *    untouched.
   *
   * Episode-level monitoring isn't toggled here — requests aren't
   * granular below the season, and an unmonitored episode inside a
   * monitored season still gets caught by the season-level grab.
   */
  async applyMonitoredForRequestScope(
    media: Media,
    seasons: number[] | null,
  ): Promise<void> {
    if (!media.monitored) {
      media.monitored = true;
      await this.mediaRepo.save(media);
    }
    if (media.type !== MediaType.SERIES || !seasons?.length) return;
    // Sub-services don't own the Season repository directly here; load via
    // the shared connection. We keep this orchestration on the façade since
    // it spans two repos and is only ever called by RequestLifecycleService.
    const seasonRepo = this.mediaRepo.manager.getRepository(Season);
    const rows = await seasonRepo.find({
      where: { media: { id: media.id } },
    });
    const targets = rows.filter(
      (s) => seasons.includes(s.seasonNumber) && !s.monitored,
    );
    if (targets.length) {
      for (const s of targets) s.monitored = true;
      await seasonRepo.save(targets);
    }
  }
}
