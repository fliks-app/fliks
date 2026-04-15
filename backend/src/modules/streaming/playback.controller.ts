import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PlaybackService } from './playback.service';
import { RecommendationService } from './recommendation.service';
import { User } from '../users/entities/user.entity';
import { LibrariesService } from '../libraries/libraries.service';

@Controller('playback')
@UseGuards(JwtOrApiKeyGuard)
export class PlaybackController {
  constructor(
    private readonly playbackService: PlaybackService,
    private readonly recommendationService: RecommendationService,
    private readonly libraries: LibrariesService,
  ) {}

  @Get('recommendations')
  async recommendations(@Req() req: Request) {
    const user = req.user as User;
    const libraryIds = await this.libraries.getAccessibleLibraryIds(user);
    return this.recommendationService.getRecommendations(user.id, libraryIds);
  }

  @Get('watched-ids')
  async watchedIds(@Req() req: Request) {
    const user = req.user as User;
    const libraryIds = await this.libraries.getAccessibleLibraryIds(user);
    return this.playbackService.getWatchedMediaIds(user.id, libraryIds);
  }

  @Get('continue-watching')
  async continueWatching(@Req() req: Request) {
    const user = req.user as User;
    const libraryIds = await this.libraries.getAccessibleLibraryIds(user);
    return this.playbackService.getContinueWatching(user.id, libraryIds);
  }

  @Get('history')
  async history(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const user = req.user as User;
    const libraryIds = await this.libraries.getAccessibleLibraryIds(user);
    return this.playbackService.getHistory(
      user.id,
      Math.max(1, Number(page) || 1),
      Math.min(100, Math.max(1, Number(limit) || 25)),
      libraryIds,
    );
  }

  @Get('media/:mediaId/watched-episodes')
  getWatchedEpisodeIds(
    @Req() req: Request,
    @Param('mediaId', ParseIntPipe) mediaId: number,
  ) {
    const user = req.user as User;
    return this.playbackService.getWatchedEpisodeIds(user.id, mediaId);
  }

  /** Progress percent per in-progress episode (episodeId → 0-100). */
  @Get('media/:mediaId/episode-progress')
  getEpisodeProgress(
    @Req() req: Request,
    @Param('mediaId', ParseIntPipe) mediaId: number,
  ) {
    const user = req.user as User;
    return this.playbackService.getEpisodeProgress(user.id, mediaId);
  }

  /** Resume info — which episode/file to resume for a media. */
  @Get('media/:mediaId')
  getMediaResumeInfo(
    @Req() req: Request,
    @Param('mediaId', ParseIntPipe) mediaId: number,
  ) {
    const user = req.user as User;
    return this.playbackService.getMediaResumeInfo(user.id, mediaId);
  }

  /** Get playback state for a specific media (movie) or episode. */
  @Get('media/:mediaId/state')
  getState(
    @Req() req: Request,
    @Param('mediaId', ParseIntPipe) mediaId: number,
    @Query('episodeId') episodeIdRaw?: string,
  ) {
    const user = req.user as User;
    const episodeId = episodeIdRaw ? parseInt(episodeIdRaw, 10) : undefined;
    return this.playbackService.getState(user.id, mediaId, episodeId);
  }

  /** Update playback state (position, duration, file). */
  @Put('media/:mediaId/state')
  updateState(
    @Req() req: Request,
    @Param('mediaId', ParseIntPipe) mediaId: number,
    @Body()
    body: {
      positionSeconds: number;
      durationSeconds: number;
      mediaFileId: number;
      episodeId?: number;
    },
  ) {
    const user = req.user as User;
    return this.playbackService.updateState(user.id, mediaId, body);
  }

  /** Toggle watched/unwatched for a media or episode. */
  @Post('media/:mediaId/toggle-watched')
  toggleWatched(
    @Req() req: Request,
    @Param('mediaId', ParseIntPipe) mediaId: number,
    @Body() body: { mediaFileId: number; episodeId?: number },
  ) {
    const user = req.user as User;
    return this.playbackService.toggleWatched(
      user.id,
      mediaId,
      body.mediaFileId,
      body.episodeId,
    );
  }

  /**
   * Mark every episode of a series as watched (or unwatched) in a single call.
   * Returns the resulting set of watched episode IDs.
   */
  @Post('media/:mediaId/toggle-series-watched')
  toggleSeriesWatched(
    @Req() req: Request,
    @Param('mediaId', ParseIntPipe) mediaId: number,
    @Body() body: { watched: boolean },
  ) {
    const user = req.user as User;
    return this.playbackService.toggleSeriesWatched(
      user.id,
      mediaId,
      !!body.watched,
    );
  }

  /** Delete playback state for a media or episode. */
  @Delete('media/:mediaId/state')
  deleteState(
    @Req() req: Request,
    @Param('mediaId', ParseIntPipe) mediaId: number,
    @Query('episodeId') episodeIdRaw?: string,
  ) {
    const user = req.user as User;
    const episodeId = episodeIdRaw ? parseInt(episodeIdRaw, 10) : undefined;
    return this.playbackService.deleteState(user.id, mediaId, episodeId);
  }

  /** Remove a media from continue watching. */
  @Delete('hide/:mediaId')
  hideFromContinueWatching(
    @Req() req: Request,
    @Param('mediaId', ParseIntPipe) mediaId: number,
  ) {
    const user = req.user as User;
    return this.playbackService.hideFromContinueWatching(user.id, mediaId);
  }
}
