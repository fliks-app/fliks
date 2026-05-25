import { Injectable } from '@nestjs/common';
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
import { MediaMutationService } from './media-service/media-mutation.service';
import { MediaRescanService } from './media-service/media-rescan.service';

/**
 * Façade in front of the media sub-services. External callers
 * (controllers, schedulers, other modules) only see this surface, so
 * the public method signatures here are load-bearing — changing them
 * means changing every importer.
 */
@Injectable()
export class MediaService {
  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    private readonly imports: MediaImportService,
    private readonly metadata: MediaMetadataService,
    private readonly query: MediaQueryService,
    private readonly mutation: MediaMutationService,
    private readonly rescan: MediaRescanService,
  ) {}

  // -- Imports ----------------------------------------------------------------

  importFromTmdb(dto: ImportTmdbDto, addedByUserId: number | null = null) {
    return this.imports.importFromTmdb(dto, addedByUserId);
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

  finalizeImportedFile(
    file: import('./entities/media-file.entity').MediaFile,
    absPath: string,
    media: Media,
  ) {
    return this.rescan.finalizeImportedFile(file, absPath, media);
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
