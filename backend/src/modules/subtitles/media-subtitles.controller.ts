import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FileInterceptor } from '@nestjs/platform-express';
import { Repository } from 'typeorm';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { FileTooLargeFilter } from '../../common/filters/file-too-large.filter';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { Media } from '../media/entities/media.entity';
import { SubtitlesService, SUBTITLE_UPLOAD_MAX_BYTES } from './subtitles.service';
import { SubtitleOcrService } from './subtitle-ocr.service';
import { SubtitleTranslationService } from './subtitle-translation.service';
import { SubtitleSyncService } from './subtitle-sync.service';
import { SubtitleFile } from './entities/subtitle-file.entity';
import { EventsService } from '../scheduler/events.service';
import { ActivityRegistryService } from '../scheduler/activity-registry.service';
import { buildMediaProgressSubject } from '../../common/utils/media-progress-subject.util';
import { SubtitleSchedulerService } from '../scheduler/subtitle-scheduler.service';
import { LibrariesService } from '../libraries/libraries.service';
import type { User } from '../users/entities/user.entity';

/**
 * The `/api/media/:id/subtitles*` routes and `sync-queue`, kept in Nest until S6 (the other
 * `/api/media` routes are served by fliks-server).
 */
@Controller('media')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class MediaSubtitlesController {
  constructor(
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    private readonly subtitlesService: SubtitlesService,
    private readonly subtitleOcr: SubtitleOcrService,
    private readonly subtitleTranslation: SubtitleTranslationService,
    private readonly subtitleSync: SubtitleSyncService,
    private readonly eventsService: EventsService,
    private readonly subtitleScheduler: SubtitleSchedulerService,
    private readonly libraries: LibrariesService,
    private readonly activityRegistry: ActivityRegistryService,
  ) {}

  /** 404 when the user can't access the media's library. */
  private async assertMediaAccessible(id: number, user: User): Promise<void> {
    const accessible = await this.libraries.getAccessibleLibraryIds(user);
    await this.libraries.assertMediaAccessible(id, accessible);
  }

  private async loadMedia(id: number): Promise<Media> {
    const media = await this.mediaRepo.findOne({
      where: { id },
      relationLoadStrategy: 'query',
      relations: ['seasons', 'seasons.episodes', 'files'],
    });
    if (!media) throw new NotFoundException(`Media #${id} not found`);
    return media;
  }

  /** The media guard above only clears `:id`. Every subtitle service method
   *  loads its row by id alone, so the two ids have to be bound as well. */
  private async assertSubtitleAccessible(
    mediaId: number,
    subtitleId: number,
    user: User,
  ): Promise<void> {
    await this.assertMediaAccessible(mediaId, user);
    await this.subtitlesService.assertBelongsToMedia(subtitleId, mediaId);
  }

  @Get(':id/subtitles')
  @CheckPolicies((ability) => ability.can(Action.Read, SubtitleFile))
  async getSubtitles(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
  ) {
    await this.assertMediaAccessible(id, user);
    const subtitles = await this.subtitlesService.getSubtitlesForMedia(id);
    // A client that opens the list mid-run would otherwise wait for the next
    // progress event, which is minutes away on a slow engine.
    for (const sub of subtitles) {
      sub.translationProgress = this.subtitleTranslation.progressFor(sub.id);
    }
    return subtitles;
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
    const media = await this.loadMedia(id);

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
    const media = await this.loadMedia(id);

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

  @Post(':id/subtitles/search-missing')
  @CheckPolicies((ability) => ability.can(Action.Create, SubtitleFile))
  async searchMissingSubtitles(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @Body() body: { mediaFileId: number },
  ) {
    await this.assertMediaAccessible(id, user);
    return this.subtitleScheduler.searchMissingForMedia(id, body.mediaFileId);
  }

  @Post(':id/subtitles/:subtitleId/ocr')
  @CheckPolicies((ability) => ability.can(Action.Create, SubtitleFile))
  async ocrSubtitle(
    @Param('id', ParseIntPipe) id: number,
    @Param('subtitleId', ParseIntPipe) subtitleId: number,
    @CurrentUser() user: User,
    @Body() body: { language?: string },
  ) {
    await this.assertSubtitleAccessible(id, subtitleId, user);
    return this.subtitleOcr.ocrSubtitle(subtitleId, body.language);
  }

  @Post(':id/subtitles/:subtitleId/translate')
  @CheckPolicies((ability) => ability.can(Action.Create, SubtitleFile))
  async translateSubtitle(
    @Param('id', ParseIntPipe) id: number,
    @Param('subtitleId', ParseIntPipe) subtitleId: number,
    @CurrentUser() user: User,
    @Body() body: { targetLanguage: string; providerId?: number },
  ) {
    await this.assertSubtitleAccessible(id, subtitleId, user);
    return this.subtitleTranslation.translateSubtitle(
      subtitleId,
      body.targetLanguage,
      body.providerId,
    );
  }

  @Patch(':id/subtitles/:subtitleId/language')
  @CheckPolicies((ability) => ability.can(Action.Update, SubtitleFile))
  async setSubtitleLanguage(
    @Param('id', ParseIntPipe) id: number,
    @Param('subtitleId', ParseIntPipe) subtitleId: number,
    @CurrentUser() user: User,
    @Body() body: { language: string },
  ) {
    await this.assertSubtitleAccessible(id, subtitleId, user);
    return this.subtitlesService.setLanguage(subtitleId, body.language);
  }

  @Post(':id/subtitles/:subtitleId/validate')
  @CheckPolicies((ability) => ability.can(Action.Update, SubtitleFile))
  async validateSubtitle(
    @Param('id', ParseIntPipe) id: number,
    @Param('subtitleId', ParseIntPipe) subtitleId: number,
    @CurrentUser() user: User,
  ) {
    await this.assertSubtitleAccessible(id, subtitleId, user);
    return this.subtitlesService.validateSubtitle(subtitleId);
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

  /** Store a subtitle the user picked on their device, as a sidecar file. */
  @Post(':id/subtitles/upload')
  @CheckPolicies((ability) => ability.can(Action.Create, SubtitleFile))
  @UseFilters(FileTooLargeFilter)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: SUBTITLE_UPLOAD_MAX_BYTES } }),
  )
  async uploadSubtitle(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
    @UploadedFile() file: Express.Multer.File,
    @Body()
    body: {
      mediaFileId: string;
      episodeId?: string;
      language: string;
      forced?: string;
      hearingImpaired?: string;
    },
  ) {
    await this.assertMediaAccessible(id, user);
    if (!file) throw new BadRequestException('No file uploaded');
    const flag = (v?: string) => (v === 'true' ? true : v === 'false' ? false : undefined);
    const mediaFileId = Number(body.mediaFileId);
    if (!Number.isInteger(mediaFileId)) {
      throw new BadRequestException('mediaFileId is required');
    }
    const episodeId = body.episodeId ? Number(body.episodeId) : undefined;
    return this.subtitlesService.uploadSubtitle(
      id,
      mediaFileId,
      episodeId,
      file,
      body.language,
      { forced: flag(body.forced), hearingImpaired: flag(body.hearingImpaired) },
    );
  }

  @Delete(':id/subtitles/:subtitleId')
  @CheckPolicies((ability) => ability.can(Action.Delete, SubtitleFile))
  async deleteSubtitle(
    @Param('id', ParseIntPipe) id: number,
    @Param('subtitleId', ParseIntPipe) subtitleId: number,
    @CurrentUser() user: User,
  ) {
    await this.assertSubtitleAccessible(id, subtitleId, user);
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
    await this.assertSubtitleAccessible(id, subtitleId, user);
    return this.subtitleSync.enqueueSyncSubtitle(subtitleId, body ?? {});
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
    await this.assertSubtitleAccessible(id, subtitleId, user);
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
    await this.assertSubtitleAccessible(id, subtitleId, user);
    return this.subtitlesService.upgradeSubtitle(subtitleId, body.searchResult);
  }
}
