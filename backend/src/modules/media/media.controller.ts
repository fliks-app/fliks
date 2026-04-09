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
import { DiskImportService } from './disk-import.service';
import { CreateMediaDto } from './dto/create-media.dto';
import { UpdateMediaDto } from './dto/update-media.dto';
import { SearchMediaDto } from './dto/search-media.dto';
import { ImportTmdbDto } from './dto/import-tmdb.dto';
import { GrabMovieDto } from './dto/grab-movie.dto';
import { ScanFolderDto } from './dto/scan-folder.dto';
import { ConfirmDiskImportDto } from './dto/confirm-disk-import.dto';
import { UpdateMediaProfilesDto } from './dto/update-media-profiles.dto';
import { BulkUpdateMediaDto } from './dto/bulk-update-media.dto';
import { CalendarQueryDto } from './dto/calendar-query.dto';
import { PatchMonitoredDto } from './dto/patch-monitored.dto';
import { UpdateRootFolderDto } from './dto/update-path.dto';
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

@Controller('media')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class MediaController {
  private readonly logger = new Logger(MediaController.name);

  constructor(
    private readonly mediaService: MediaService,
    private readonly movieDownload: MovieDownloadService,
    private readonly episodeDownload: EpisodeDownloadService,
    private readonly diskImport: DiskImportService,
    private readonly subtitlesService: SubtitlesService,
    private readonly subtitleSync: SubtitleSyncService,
    private readonly ffprobe: FfprobeService,
    private readonly eventsService: EventsService,
  ) {}

  @Post('import/tmdb')
  @CheckPolicies((ability) => ability.can(Action.Create, Media))
  importFromTmdb(@Body() dto: ImportTmdbDto) {
    return this.mediaService.importFromTmdb(dto);
  }

  @Post('import/disk/scan')
  @CheckPolicies((ability) => ability.can(Action.Create, Media))
  diskScan(@Body() dto: ScanFolderDto) {
    return this.diskImport.scanFolder(dto.folderPath);
  }

  @Post('import/disk/confirm')
  @CheckPolicies((ability) => ability.can(Action.Create, Media))
  diskConfirm(@Body() dto: ConfirmDiskImportDto) {
    return this.diskImport.confirmImport(dto.imports);
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Create, Media))
  create(@Body() dto: CreateMediaDto) {
    return this.mediaService.create(dto);
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  findAll(@Query() query: SearchMediaDto, @CurrentUser() user: any) {
    return this.mediaService.findAll(
      query,
      query.excludeWatched ? user?.id : undefined,
    );
  }

  @Get('counts')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  counts() {
    return this.mediaService.getCounts();
  }

  @Get('qualities')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  qualityDefinitions() {
    return APP_QUALITIES;
  }

  @Get('calendar')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  calendar(@Query() query: CalendarQueryDto) {
    return this.mediaService.getCalendar(query);
  }

  @Patch('bulk')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  bulkUpdate(@Body() dto: BulkUpdateMediaDto) {
    return this.mediaService.bulkUpdate(dto);
  }

  @Post(':id/rename')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  renameFiles(@Param('id', ParseIntPipe) id: number) {
    return this.mediaService.renameFiles(id);
  }

  @Get(':id/releases')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  movieReleases(
    @Param('id', ParseIntPipe) id: number,
    @Query('q') customQuery?: string,
  ) {
    return this.movieDownload.searchMovieReleases(id, customQuery);
  }

  @Post(':id/grab')
  @CheckPolicies((ability) => ability.can(Action.Grab, Media))
  grabMovie(@Param('id', ParseIntPipe) id: number, @Body() dto: GrabMovieDto) {
    return this.movieDownload.grabMovie(id, dto ?? {});
  }

  @Get(':id/upgrade-releases')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  upgradeReleases(
    @Param('id', ParseIntPipe) id: number,
    @Query('q') customQuery?: string,
  ) {
    return this.movieDownload.searchUpgradeReleases(id, customQuery);
  }

  @Post(':id/upgrade')
  @CheckPolicies((ability) => ability.can(Action.Grab, Media))
  grabUpgrade(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: GrabMovieDto,
  ) {
    return this.movieDownload.grabUpgrade(id, dto ?? {});
  }

  @Get(':id/seasons/:seasonId/releases')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  seasonReleases(
    @Param('id', ParseIntPipe) id: number,
    @Param('seasonId', ParseIntPipe) seasonId: number,
    @Query('q') customQuery?: string,
  ) {
    return this.episodeDownload.searchSeasonReleases(id, seasonId, customQuery);
  }

  @Post(':id/seasons/:seasonId/grab')
  @CheckPolicies((ability) => ability.can(Action.Grab, Media))
  grabSeason(
    @Param('id', ParseIntPipe) id: number,
    @Param('seasonId', ParseIntPipe) seasonId: number,
    @Body() dto: GrabMovieDto,
  ) {
    return this.episodeDownload.grabSeason(id, seasonId, dto ?? {});
  }

  @Get(':id/episodes/:episodeId/releases')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  episodeReleases(
    @Param('id', ParseIntPipe) id: number,
    @Param('episodeId', ParseIntPipe) episodeId: number,
    @Query('q') customQuery?: string,
  ) {
    return this.episodeDownload.searchEpisodeReleases(
      id,
      episodeId,
      customQuery,
    );
  }

  @Post(':id/episodes/:episodeId/grab')
  @CheckPolicies((ability) => ability.can(Action.Grab, Media))
  grabEpisode(
    @Param('id', ParseIntPipe) id: number,
    @Param('episodeId', ParseIntPipe) episodeId: number,
    @Body() dto: GrabMovieDto,
  ) {
    return this.episodeDownload.grabEpisode(id, episodeId, dto ?? {});
  }

  @Delete(':id/files/:fileId')
  @CheckPolicies((ability) => ability.can(Action.Delete, Media))
  deleteFile(
    @Param('id', ParseIntPipe) id: number,
    @Param('fileId', ParseIntPipe) fileId: number,
    @Query('deleteOnDisk') deleteOnDisk?: string,
  ) {
    return this.mediaService.deleteMediaFile(
      id,
      fileId,
      deleteOnDisk === 'true',
    );
  }

  @Patch(':id/root-folder')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  updateRootFolder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRootFolderDto,
  ) {
    return this.mediaService.updateRootFolder(id, dto.rootFolderId);
  }

  @Patch(':id/profiles')
  @CheckPolicies(
    (ability) =>
      ability.can(Action.Grab, Media) || ability.can(Action.Update, Media),
  )
  updateProfiles(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateMediaProfilesDto,
  ) {
    return this.mediaService.updateProfiles(id, dto);
  }

  @Post(':id/refresh')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  refreshMetadata(@Param('id', ParseIntPipe) id: number) {
    return this.mediaService.refreshMetadata(id);
  }

  @Post(':id/episodes/:episodeId/refresh')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  refreshEpisodeMetadata(
    @Param('id', ParseIntPipe) id: number,
    @Param('episodeId', ParseIntPipe) episodeId: number,
  ) {
    return this.mediaService.refreshEpisodeMetadata(id, episodeId);
  }

  @Post(':id/rescan')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  async rescanFiles(@Param('id', ParseIntPipe) id: number) {
    const media = await this.mediaService.findOne(id);
    if (!media) throw new NotFoundException(`Media #${id} not found`);
    const title = media.title;

    this.logger.log(`Media rescan started (API) — id=${id} title="${title}"`);
    this.eventsService.emit({ type: 'rescan.started', mediaId: id, title });

    // Fire-and-forget: don't await
    void this.mediaService.rescanFiles(id).then(
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

  @Get(':id/subtitles')
  @CheckPolicies((ability) => ability.can(Action.Read, SubtitleFile))
  getSubtitles(@Param('id', ParseIntPipe) id: number) {
    return this.subtitlesService.getSubtitlesForMedia(id);
  }

  @Get(':id/subtitles/search')
  @CheckPolicies((ability) => ability.can(Action.Read, SubtitleFile))
  async searchSubtitles(
    @Param('id', ParseIntPipe) id: number,
    @Query('language') language?: string,
    @Query('episodeId') episodeId?: string,
  ) {
    const media = await this.mediaService.findOne(id);

    // `episodeId` = id DB de l'épisode ; les APIs (OpenSubtitles, Subdl…) attendent
    // season_number + episode_number (ex. S02E05 → 2 et 5), pas la clé primaire.
    let season: number | undefined;
    let episode: number | undefined;
    if (episodeId != null && episodeId !== '') {
      const epDbId = Number(episodeId);
      if (Number.isFinite(epDbId)) {
        for (const s of media.seasons ?? []) {
          const ep = s.episodes?.find((e) => e.id === epDbId);
          if (ep) {
            season = s.seasonNumber;
            episode = ep.episodeNumber;
            break;
          }
        }
      }
    }

    return this.subtitlesService.searchSubtitles({
      imdbId: media.imdbId ?? undefined,
      tmdbId: media.tmdbId,
      title: media.title,
      year: media.year ?? undefined,
      language: language ?? 'en',
      season,
      episode,
    });
  }

  @Post(':id/subtitles/auto')
  @CheckPolicies((ability) => ability.can(Action.Create, SubtitleFile))
  async autoSubtitle(
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: { mediaFileId: number; episodeId?: number; language?: string },
  ) {
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
    @Body()
    body: { searchResult: any; mediaFileId: number; episodeId?: number },
  ) {
    return this.subtitlesService.downloadSubtitle(
      id,
      body.mediaFileId,
      body.episodeId,
      body.searchResult,
    );
  }

  @Delete(':id/subtitles/:subtitleId')
  @CheckPolicies((ability) => ability.can(Action.Delete, SubtitleFile))
  deleteSubtitle(
    @Param('id', ParseIntPipe) _id: number,
    @Param('subtitleId', ParseIntPipe) subtitleId: number,
  ) {
    return this.subtitlesService.deleteSubtitle(subtitleId);
  }

  @Post(':id/subtitles/:subtitleId/sync')
  @CheckPolicies((ability) => ability.can(Action.Create, SubtitleFile))
  async syncSubtitle(
    @Param('id', ParseIntPipe) _id: number,
    @Param('subtitleId', ParseIntPipe) subtitleId: number,
    @Body()
    body?: {
      reference?: string;
      maxOffsetSeconds?: number;
      noFixFramerate?: boolean;
      goldenSectionSearch?: boolean;
    },
  ) {
    return this.subtitleSync.enqueueSyncSubtitle(subtitleId, body ?? {});
  }

  @Get(':id/streams/:mediaFileId')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  async getStreams(
    @Param('id', ParseIntPipe) id: number,
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
  ) {
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
    @Param('id', ParseIntPipe) _id: number,
    @Param('subtitleId', ParseIntPipe) subtitleId: number,
    @Body() body: { action: string; params?: Record<string, unknown> },
  ) {
    return this.subtitlesService.applyPostProcessing(
      subtitleId,
      body.action,
      body.params,
    );
  }

  @Post(':id/subtitles/:subtitleId/upgrade')
  @CheckPolicies((ability) => ability.can(Action.Create, SubtitleFile))
  async upgradeSubtitle(
    @Param('id', ParseIntPipe) _id: number,
    @Param('subtitleId', ParseIntPipe) subtitleId: number,
    @Body() body: { searchResult: any },
  ) {
    return this.subtitlesService.upgradeSubtitle(subtitleId, body.searchResult);
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.mediaService.findOne(id);
  }

  @Get(':id/cast')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  getCast(@Param('id', ParseIntPipe) id: number) {
    return this.mediaService.getCast(id);
  }

  @Get(':id/crew')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  getCrew(@Param('id', ParseIntPipe) id: number) {
    return this.mediaService.getCrew(id);
  }

  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateMediaDto) {
    return this.mediaService.update(id, dto);
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Delete, Media))
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.mediaService.remove(id);
  }

  @Patch('seasons/:seasonId')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  patchSeason(
    @Param('seasonId', ParseIntPipe) seasonId: number,
    @Body() dto: PatchMonitoredDto,
  ) {
    return this.mediaService.updateSeasonMonitored(seasonId, dto.monitored);
  }

  @Patch('episodes/:episodeId')
  @CheckPolicies((ability) => ability.can(Action.Update, Media))
  patchEpisode(
    @Param('episodeId', ParseIntPipe) episodeId: number,
    @Body() dto: PatchMonitoredDto,
  ) {
    return this.mediaService.updateEpisodeMonitored(episodeId, dto.monitored);
  }
}
