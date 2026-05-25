import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { MediaService } from './media.service';
import { MovieDownloadService } from './movie-download.service';
import { EpisodeDownloadService } from './episode-download.service';
import { CreateMediaDto } from './dto/create-media.dto';
import { UpdateMediaDto } from './dto/update-media.dto';
import { SearchMediaDto } from './dto/search-media.dto';
import { AnalyzeMediaDto } from './dto/analyze-media.dto';
import { ImportTmdbDto } from './dto/import-tmdb.dto';
import { ImportMediaDto } from './dto/import-media.dto';
import { GrabMovieDto } from './dto/grab-movie.dto';
import { UpdateMediaProfilesDto } from './dto/update-media-profiles.dto';
import { BulkUpdateMediaDto } from './dto/bulk-update-media.dto';
import { CalendarQueryDto } from './dto/calendar-query.dto';
import { PatchMonitoredDto } from './dto/patch-monitored.dto';
import { PatchSeasonDto } from './dto/patch-season.dto';
import { APP_QUALITIES } from '../../common/constants/app-qualities';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { Media } from './entities/media.entity';
import { SubtitlesService } from '../subtitles/subtitles.service';
import { SubtitleSyncService } from '../subtitles/subtitle-sync.service';
import { FfprobeService } from '../subtitles/ffprobe.service';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { EventsService } from '../scheduler/events.service';
import { LibrariesService } from '../libraries/libraries.service';
import type { User } from '../users/entities/user.entity';

@Controller('media')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class MediaController {
  private readonly logger = new Logger(MediaController.name);

  constructor(
    private readonly mediaService: MediaService,
    private readonly movieDownload: MovieDownloadService,
    private readonly episodeDownload: EpisodeDownloadService,
    private readonly subtitlesService: SubtitlesService,
    private readonly subtitleSync: SubtitleSyncService,
    private readonly ffprobe: FfprobeService,
    private readonly eventsService: EventsService,
    private readonly libraries: LibrariesService,
  ) {}

  /**
   * Throws NotFound when the user can't access the media's library.
   * Use at the start of every per-media endpoint to seal off cross-library leaks.
   */
  private async assertMediaAccessible(id: number, user: User): Promise<void> {
    const accessible = await this.libraries.getAccessibleLibraryIds(user);
    await this.mediaService.assertAccessible(id, accessible);
  }

  @Post('import/tmdb')
  @CheckPolicies((ability) => ability.can(Action.Create, Media))
  importFromTmdb(@Body() dto: ImportTmdbDto, @CurrentUser() user: User) {
    return this.mediaService.importFromTmdb(dto, user?.id ?? null);
  }

  @Post('import')
  @CheckPolicies((ability) => ability.can(Action.Create, Media))
  importMedia(@Body() dto: ImportMediaDto, @CurrentUser() user: User) {
    return this.mediaService.importMedia(dto, user?.id ?? null);
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Create, Media))
  create(@Body() dto: CreateMediaDto) {
    return this.mediaService.create(dto);
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  async findAll(@Query() query: SearchMediaDto, @CurrentUser() user: User) {
    const accessibleLibraryIds =
      await this.libraries.getAccessibleLibraryIds(user);
    return this.mediaService.findAll(
      query,
      query.excludeWatched || query.onlyWatched || query.requestedByMe
        ? user?.id
        : undefined,
      accessibleLibraryIds,
    );
  }

  @Get('counts')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  async counts(@CurrentUser() user: User) {
    const accessibleLibraryIds =
      await this.libraries.getAccessibleLibraryIds(user);
    return this.mediaService.getCounts(accessibleLibraryIds);
  }

  @Get('counts-by-library')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  async countsByLibrary(@CurrentUser() user: User) {
    const accessibleLibraryIds =
      await this.libraries.getAccessibleLibraryIds(user);
    return this.mediaService.getCountsByLibrary(accessibleLibraryIds);
  }

  @Get('qualities')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  qualityDefinitions() {
    return APP_QUALITIES;
  }

  /** Distinct genres present in a library, each with item count + the
   *  poster URLs of up to 4 sample items (rendered as a mosaic on the
   *  library Genres tab). When `libraryId` is omitted the user's whole
   *  accessible scope is aggregated. */
  @Get('genres')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  async genres(
    @CurrentUser() user: User,
    @Query('libraryId') libraryIdRaw?: string,
  ) {
    const accessible = await this.libraries.getAccessibleLibraryIds(user);
    let libraryIds = accessible;
    const libraryId = libraryIdRaw ? parseInt(libraryIdRaw, 10) : null;
    if (libraryId && Number.isFinite(libraryId)) {
      libraryIds = accessible.includes(libraryId) ? [libraryId] : [];
    }
    return this.mediaService.getGenres(libraryIds);
  }

  @Get('collections')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  async collections(
    @CurrentUser() user: User,
    @Query('libraryId') libraryIdRaw?: string,
  ) {
    const accessible = await this.libraries.getAccessibleLibraryIds(user);
    let libraryIds = accessible;
    const libraryId = libraryIdRaw ? parseInt(libraryIdRaw, 10) : null;
    if (libraryId && Number.isFinite(libraryId)) {
      libraryIds = accessible.includes(libraryId) ? [libraryId] : [];
    }
    return this.mediaService.getCollections(libraryIds);
  }

  @Get('calendar')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  async calendar(@Query() query: CalendarQueryDto, @CurrentUser() user: User) {
    const accessibleLibraryIds =
      await this.libraries.getAccessibleLibraryIds(user);
    return this.mediaService.getCalendar(query, accessibleLibraryIds, user?.id);
  }

  @Patch('bulk')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  bulkUpdate(@Body() dto: BulkUpdateMediaDto) {
    return this.mediaService.bulkUpdate(dto);
  }

  @Get(':id/releases')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  async movieReleases(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @Query('q') customQuery?: string,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.movieDownload.searchMovieReleases(id, customQuery);
  }

  @Post(':id/grab')
  @CheckPolicies((ability) => ability.can(Action.Grab, Media))
  async grabMovie(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @Body() dto: GrabMovieDto,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.movieDownload.grabMovie(id, dto ?? {});
  }

  @Get(':id/upgrade-releases')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  async upgradeReleases(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @Query('q') customQuery?: string,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.movieDownload.searchUpgradeReleases(id, customQuery);
  }

  @Post(':id/upgrade')
  @CheckPolicies((ability) => ability.can(Action.Grab, Media))
  async grabUpgrade(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @Body() dto: GrabMovieDto,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.movieDownload.grabUpgrade(id, dto ?? {});
  }

  @Get(':id/seasons/:seasonId/releases')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  async seasonReleases(
    @Param('id', ParseIntPipe) id: number,
    @Param('seasonId', ParseIntPipe) seasonId: number,
    @CurrentUser() user: User,
    @Query('q') customQuery?: string,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.episodeDownload.searchSeasonReleases(id, seasonId, customQuery);
  }

  @Post(':id/seasons/:seasonId/grab')
  @CheckPolicies((ability) => ability.can(Action.Grab, Media))
  async grabSeason(
    @Param('id', ParseIntPipe) id: number,
    @Param('seasonId', ParseIntPipe) seasonId: number,
    @CurrentUser() user: User,
    @Body() dto: GrabMovieDto,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.episodeDownload.grabSeason(id, seasonId, dto ?? {});
  }

  @Get(':id/episodes/:episodeId/releases')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  async episodeReleases(
    @Param('id', ParseIntPipe) id: number,
    @Param('episodeId', ParseIntPipe) episodeId: number,
    @CurrentUser() user: User,
    @Query('q') customQuery?: string,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.episodeDownload.searchEpisodeReleases(
      id,
      episodeId,
      customQuery,
    );
  }

  @Post(':id/episodes/:episodeId/grab')
  @CheckPolicies((ability) => ability.can(Action.Grab, Media))
  async grabEpisode(
    @Param('id', ParseIntPipe) id: number,
    @Param('episodeId', ParseIntPipe) episodeId: number,
    @CurrentUser() user: User,
    @Body() dto: GrabMovieDto,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.episodeDownload.grabEpisode(id, episodeId, dto ?? {});
  }

  @Delete(':id/files/:fileId')
  @CheckPolicies((ability) => ability.can(Action.Delete, Media))
  async deleteFile(
    @Param('id', ParseIntPipe) id: number,
    @Param('fileId', ParseIntPipe) fileId: number,
    @CurrentUser() user: User,
    @Query('deleteOnDisk') deleteOnDisk?: string,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.mediaService.deleteMediaFile(
      id,
      fileId,
      deleteOnDisk === 'true',
    );
  }

  @Patch(':id/library')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  async updateLibrary(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @Body() dto: { libraryId: number },
  ) {
    await this.assertMediaAccessible(id, user);
    return this.mediaService.updateLibrary(id, dto.libraryId);
  }

  @Patch(':id/profiles')
  @CheckPolicies(
    (ability) =>
      ability.can(Action.Grab, Media) || ability.can(Action.Update, Media),
  )
  async updateProfiles(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @Body() dto: UpdateMediaProfilesDto,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.mediaService.updateProfiles(id, dto);
  }

  @Post(':id/refresh')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  async refreshMetadata(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
  ) {
    await this.assertMediaAccessible(id, user);
    const media = await this.mediaService.findOne(id);
    if (!media) throw new NotFoundException(`Media #${id} not found`);
    const title = media.title;

    this.eventsService.emit({ type: 'metadata.started', mediaId: id, title });
    // Fire-and-forget so the client doesn't sit waiting on TMDB + image
    // downloads. SSE event signals completion.
    void this.mediaService.refreshMetadata(id).then(
      () => {
        this.eventsService.emit({
          type: 'metadata.refreshed',
          mediaId: id,
          title,
        });
      },
      (err) => {
        const message = (err as Error).message;
        this.logger.error(
          `Metadata refresh failed — id=${id} title="${title}" error=${message}`,
          err instanceof Error ? err.stack : err,
        );
        this.eventsService.emit({
          type: 'metadata.failed',
          mediaId: id,
          title,
          error: message,
        });
      },
    );
    return { ok: true };
  }

  @Post(':id/episodes/:episodeId/refresh')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  async refreshEpisodeMetadata(
    @Param('id', ParseIntPipe) id: number,
    @Param('episodeId', ParseIntPipe) episodeId: number,
    @CurrentUser() user: User,
  ) {
    await this.assertMediaAccessible(id, user);
    const media = await this.mediaService.findOne(id);
    if (!media) throw new NotFoundException(`Media #${id} not found`);
    const title = media.title;

    this.eventsService.emit({ type: 'metadata.started', mediaId: id, title });
    void this.mediaService.refreshEpisodeMetadata(id, episodeId).then(
      () => {
        this.eventsService.emit({
          type: 'metadata.refreshed',
          mediaId: id,
          title,
        });
      },
      (err) => {
        const message = (err as Error).message;
        this.logger.error(
          `Episode metadata refresh failed — id=${id} ep=${episodeId} error=${message}`,
          err instanceof Error ? err.stack : err,
        );
        this.eventsService.emit({
          type: 'metadata.failed',
          mediaId: id,
          title,
          error: message,
        });
      },
    );
    return { ok: true };
  }

  @Post(':id/rescan')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  async rescanFiles(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
  ) {
    await this.assertMediaAccessible(id, user);
    const media = await this.mediaService.findOne(id);
    if (!media) throw new NotFoundException(`Media #${id} not found`);
    const title = media.title;

    this.logger.log(`Media rescan started (API) — id=${id} title="${title}"`);
    this.eventsService.emit({ type: 'rescan.started', mediaId: id, title });

    // Fire-and-forget: don't await. skipWarmup=true — rescan should be fast,
    // subtitle cache will warm lazily when the user actually plays the file.
    void this.mediaService.rescanFiles(id, { skipWarmup: true }).then(
      (result) => {
        this.eventsService.emit({
          type: 'rescan.completed',
          mediaId: id,
          title,
          added: result.added,
          removed: result.removed,
          updated: result.updated,
          subtitleRemovedMissing: result.subtitleRemovedMissing,
          subtitleRemovedDuplicates: result.subtitleRemovedDuplicates,
        });
      },
      (err) => {
        const message = (err as Error).message;
        this.logger.error(
          `Media rescan failed — id=${id} title="${title}" error=${message}`,
          err instanceof Error ? err.stack : err,
        );
        this.eventsService.emit({
          type: 'rescan.failed',
          mediaId: id,
          title,
          error: message,
        });
      },
    );

    return { ok: true };
  }

  @Post(':id/analyze')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  async analyzeMedia(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AnalyzeMediaDto,
    @CurrentUser() user: User,
  ) {
    await this.assertMediaAccessible(id, user);
    const media = await this.mediaService.findOne(id);
    if (!media) throw new NotFoundException(`Media #${id} not found`);
    this.logger.log(
      `Media analyze started (API) — id=${id} title="${media.title}" opts=${JSON.stringify(dto)}`,
    );
    void this.mediaService.analyzeMedia(id, dto).catch((err) => {
      this.logger.error(
        `Media analyze failed — id=${id} title="${media.title}" error=${(err as Error).message}`,
        err instanceof Error ? err.stack : err,
      );
    });
    return { ok: true };
  }

  @Get(':id/subtitles')
  @CheckPolicies((ability) => ability.can(Action.Read, SubtitleFile))
  async getSubtitles(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.subtitlesService.getSubtitlesForMedia(id);
  }

  @Get(':id/subtitles/search')
  @CheckPolicies((ability) => ability.can(Action.Read, SubtitleFile))
  async searchSubtitles(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @Query('language') language?: string,
    @Query('episodeId') episodeId?: string,
  ) {
    await this.assertMediaAccessible(id, user);
    const media = await this.mediaService.findOne(id);

    // `episodeId` = id DB de l'épisode ; les APIs (OpenSubtitles, Subdl…) attendent
    // season_number + episode_number (ex. S02E05 → 2 et 5), pas la clé primaire.
    let season: number | undefined;
    let episode: number | undefined;
    let epDbIdResolved: number | undefined;
    if (episodeId != null && episodeId !== '') {
      const epDbId = Number(episodeId);
      if (Number.isFinite(epDbId)) {
        for (const s of media.seasons ?? []) {
          const ep = s.episodes?.find((e) => e.id === epDbId);
          if (ep) {
            season = s.seasonNumber;
            episode = ep.episodeNumber;
            epDbIdResolved = epDbId;
            break;
          }
        }
      }
    }

    // Try to pick the file that backs the user's view so the scorer can
    // compare release attributes (group / source / resolution / codecs).
    // For episodes we want the file linked to the picked episode; for
    // movies the first file (movies have at most one in practice).
    const files = media.files ?? [];
    const matchingFile =
      (epDbIdResolved != null
        ? files.find((f) => f.episodeId === epDbIdResolved)
        : files[0]) ?? files[0];
    const videoReleaseName = matchingFile?.relativePath
      ? matchingFile.relativePath.split('/').pop()?.replace(/\.[^.]+$/, '')
      : undefined;

    return this.subtitlesService.searchSubtitles({
      imdbId: media.imdbId ?? undefined,
      tmdbId: media.tmdbId,
      title: media.title,
      year: media.year ?? undefined,
      language: language ?? 'en',
      season,
      episode,
      videoReleaseName,
      moviehash: matchingFile?.osdbHash ?? undefined,
      moviebytesize: matchingFile?.osdbBytesize ?? undefined,
    });
  }

  @Post(':id/subtitles/auto')
  @CheckPolicies((ability) => ability.can(Action.Create, SubtitleFile))
  async autoSubtitle(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @Body()
    body: { mediaFileId: number; episodeId?: number; language?: string },
  ) {
    await this.assertMediaAccessible(id, user);
    const media = await this.mediaService.findOne(id);

    let season: number | undefined;
    let episode: number | undefined;
    if (body.episodeId != null) {
      for (const s of media.seasons ?? []) {
        const ep = s.episodes?.find((e) => e.id === body.episodeId);
        if (ep) {
          season = s.seasonNumber;
          episode = ep.episodeNumber;
          break;
        }
      }
    }

    return this.subtitlesService.autoDownload(
      id,
      body.mediaFileId,
      body.episodeId,
      {
        imdbId: media.imdbId ?? undefined,
        tmdbId: media.tmdbId,
        title: media.title,
        year: media.year ?? undefined,
        language: body.language ?? 'fr',
        season,
        episode,
      },
    );
  }

  @Post(':id/subtitles/download')
  @CheckPolicies((ability) => ability.can(Action.Create, SubtitleFile))
  async downloadSubtitle(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @Body()
    body: { searchResult: any; mediaFileId: number; episodeId?: number },
  ) {
    await this.assertMediaAccessible(id, user);
    return this.subtitlesService.downloadSubtitle(
      id,
      body.mediaFileId,
      body.episodeId,
      body.searchResult,
    );
  }

  @Delete(':id/subtitles/:subtitleId')
  @CheckPolicies((ability) => ability.can(Action.Delete, SubtitleFile))
  async deleteSubtitle(
    @Param('id', ParseIntPipe) id: number,
    @Param('subtitleId', ParseIntPipe) subtitleId: number,
    @CurrentUser() user: User,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.subtitlesService.deleteSubtitle(subtitleId);
  }

  @Post(':id/subtitles/:subtitleId/sync')
  @CheckPolicies((ability) => ability.can(Action.Create, SubtitleFile))
  async syncSubtitle(
    @Param('id', ParseIntPipe) id: number,
    @Param('subtitleId', ParseIntPipe) subtitleId: number,
    @CurrentUser() user: User,
    @Body()
    body?: {
      reference?: string;
      maxOffsetSeconds?: number;
      noFixFramerate?: boolean;
      goldenSectionSearch?: boolean;
    },
  ) {
    await this.assertMediaAccessible(id, user);
    return this.subtitleSync.enqueueSyncSubtitle(subtitleId, body ?? {});
  }

  @Get(':id/streams/:mediaFileId')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  async getStreams(
    @Param('id', ParseIntPipe) id: number,
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @CurrentUser() user: User,
  ) {
    await this.assertMediaAccessible(id, user);
    const media = await this.mediaService.findOne(id);
    const file = media.files?.find((f) => f.id === mediaFileId);
    if (!file)
      throw new NotFoundException(`MediaFile #${mediaFileId} not found`);
    const path = require('path');
    const videoPath = path.join(media.path, file.relativePath);
    return this.ffprobe.detectStreams(videoPath);
  }

  @Get('sync-queue')
  @CheckPolicies((ability) => ability.can(Action.Read, SubtitleFile))
  getSyncQueue() {
    return this.subtitleSync.getQueue();
  }

  @Post(':id/subtitles/:subtitleId/post-process')
  @CheckPolicies((ability) => ability.can(Action.Create, SubtitleFile))
  async postProcessSubtitle(
    @Param('id', ParseIntPipe) id: number,
    @Param('subtitleId', ParseIntPipe) subtitleId: number,
    @CurrentUser() user: User,
    @Body() body: { action: string; params?: Record<string, unknown> },
  ) {
    await this.assertMediaAccessible(id, user);
    return this.subtitlesService.applyPostProcessing(
      subtitleId,
      body.action,
      body.params,
    );
  }

  @Post(':id/subtitles/:subtitleId/upgrade')
  @CheckPolicies((ability) => ability.can(Action.Create, SubtitleFile))
  async upgradeSubtitle(
    @Param('id', ParseIntPipe) id: number,
    @Param('subtitleId', ParseIntPipe) subtitleId: number,
    @CurrentUser() user: User,
    @Body() body: { searchResult: any },
  ) {
    await this.assertMediaAccessible(id, user);
    return this.subtitlesService.upgradeSubtitle(subtitleId, body.searchResult);
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
  ) {
    const accessibleLibraryIds =
      await this.libraries.getAccessibleLibraryIds(user);
    await this.mediaService.assertAccessible(id, accessibleLibraryIds);
    return this.mediaService.findOne(id);
  }

  @Get(':id/cast')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  async getCast(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.mediaService.getCast(id);
  }

  @Get(':id/crew')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  async getCrew(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.mediaService.getCrew(id);
  }

  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  async update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @Body() dto: UpdateMediaDto,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.mediaService.update(id, dto);
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Delete, Media))
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
  ) {
    await this.assertMediaAccessible(id, user);
    return this.mediaService.remove(id);
  }

  @Patch('seasons/:seasonId')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  async patchSeason(
    @Param('seasonId', ParseIntPipe) seasonId: number,
    @CurrentUser() user: User,
    @Body() dto: PatchSeasonDto,
  ) {
    const mediaId = await this.mediaService.getMediaIdForSeason(seasonId);
    await this.assertMediaAccessible(mediaId, user);
    return this.mediaService.updateSeason(seasonId, dto);
  }

  @Patch('episodes/:episodeId')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  async patchEpisode(
    @Param('episodeId', ParseIntPipe) episodeId: number,
    @CurrentUser() user: User,
    @Body() dto: PatchMonitoredDto,
  ) {
    const mediaId = await this.mediaService.getMediaIdForEpisode(episodeId);
    await this.assertMediaAccessible(mediaId, user);
    return this.mediaService.updateEpisodeMonitored(episodeId, dto.monitored);
  }
}
