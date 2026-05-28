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
  HttpCode,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PlaybackService } from './playback.service';
import { RecommendationService } from './recommendation.service';
import { User } from '../users/entities/user.entity';
import { LibrariesService } from '../libraries/libraries.service';
import {
  LiveSessionRegistry,
  type PlaybackState as LivePlaybackState,
} from './live-session.service';

/** Debounce window for DB writes — heartbeat fires every 10 s but we
 *  flush playback state on a coarser cadence to avoid hammering
 *  `playback_states` on a busy household. State transitions and the
 *  "completed" threshold short-circuit the debounce. */
const STATE_DB_WRITE_INTERVAL_MS = 30_000;

@Controller('playback')
@UseGuards(JwtOrApiKeyGuard)
export class PlaybackController {
  /** When the last DB write happened per `(userId, mediaId, episodeId)`
   *  tuple. Drives the debounce above. In-memory map — moves to a
   *  shared store the day Fliks runs across multiple backend instances. */
  private readonly lastDbWriteAt = new Map<string, number>();

  constructor(
    private readonly playbackService: PlaybackService,
    private readonly recommendationService: RecommendationService,
    private readonly libraries: LibrariesService,
    private readonly liveSessions: LiveSessionRegistry,
  ) {}

  @Get('recommendations')
  async recommendations(
    @Req() req: Request,
    @Query('libraryId') libraryIdRaw?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const user = req.user as User;
    const accessible = await this.libraries.getAccessibleLibraryIds(user);
    // Scope to a single library when requested, but only if it's in the
    // user's accessible set — silent intersection (empty result) rather
    // than a 403, to keep the page renderable.
    let libraryIds = accessible;
    const libraryId = libraryIdRaw ? parseInt(libraryIdRaw, 10) : null;
    if (libraryId && Number.isFinite(libraryId)) {
      libraryIds = accessible.includes(libraryId) ? [libraryId] : [];
    }
    const limit = limitRaw
      ? Math.min(50, Math.max(1, parseInt(limitRaw, 10) || 15))
      : undefined;
    return this.recommendationService.getRecommendations(
      user.id,
      libraryIds,
      limit,
    );
  }

  /** Persist a "remove from recommendations" gesture. Idempotent. */
  @Post('recommendations/:mediaId/dismiss')
  @HttpCode(204)
  dismissRecommendation(
    @Req() req: Request,
    @Param('mediaId', ParseIntPipe) mediaId: number,
  ) {
    const user = req.user as User;
    return this.recommendationService.dismiss(user.id, mediaId);
  }

  /** How many recommendations the calling user has dismissed so far. */
  @Get('recommendations/dismissed/count')
  async dismissalsCount(@CurrentUser() user: User) {
    return { count: await this.recommendationService.countDismissals(user.id) };
  }

  /** Drop every dismissal for the calling user. */
  @Delete('recommendations/dismissed')
  resetDismissals(@CurrentUser() user: User) {
    return this.recommendationService.resetDismissals(user.id);
  }

  @Get('watched-ids')
  async watchedIds(@Req() req: Request) {
    const user = req.user as User;
    const libraryIds = await this.libraries.getAccessibleLibraryIds(user);
    return this.playbackService.getWatchedMediaIds(user.id, libraryIds);
  }

  @Get('continue-watching')
  async continueWatching(
    @Req() req: Request,
    @Query('libraryId') libraryIdRaw?: string,
  ) {
    const user = req.user as User;
    const accessible = await this.libraries.getAccessibleLibraryIds(user);
    let libraryIds = accessible;
    const libraryId = libraryIdRaw ? parseInt(libraryIdRaw, 10) : null;
    if (libraryId && Number.isFinite(libraryId)) {
      libraryIds = accessible.includes(libraryId) ? [libraryId] : [];
    }
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

  /** Update playback state (position, duration, file). Doubles as the
   *  live-session heartbeat when the client includes `sessionId` —
   *  refreshes the in-memory {@link LiveSessionRegistry} on every call
   *  and debounces the actual DB write to one every
   *  {@link STATE_DB_WRITE_INTERVAL_MS}. State transitions
   *  (`playing` ↔ `paused`) and completion always force a flush. */
  @Put('media/:mediaId/state')
  async updateState(
    @Req() req: Request,
    @Param('mediaId', ParseIntPipe) mediaId: number,
    @Body()
    body: {
      positionSeconds: number;
      durationSeconds: number;
      mediaFileId: number;
      episodeId?: number;
      // Optional heartbeat fields — present once the client embeds the
      // sessionId emitted by `playback-info`.
      sessionId?: string;
      state?: LivePlaybackState;
      quality?: string | null;
      audioTrackIndex?: number | null;
      subtitleTrackIndex?: number | null;
    },
  ) {
    const user = req.user as User;

    let stateChanged = false;
    if (body.sessionId) {
      const before = this.liveSessions.get(body.sessionId);
      const previousState = before?.state;
      const updated = this.liveSessions.heartbeat(body.sessionId, {
        position: body.positionSeconds,
        state: body.state,
        quality: body.quality,
        audioTrackIndex: body.audioTrackIndex,
        subtitleTrackIndex: body.subtitleTrackIndex,
      });
      stateChanged = !!updated && !!body.state && previousState !== body.state;
    }

    const dbKey = `${user.id}:${mediaId}:${body.episodeId ?? 0}`;
    const now = Date.now();
    const lastWrite = this.lastDbWriteAt.get(dbKey) ?? 0;
    const dur = body.durationSeconds ?? 0;
    const pos = body.positionSeconds ?? 0;
    const wouldCompleteRow = dur > 0 && (pos >= dur - 30 || pos >= dur * 0.9);
    const shouldFlushDb =
      stateChanged ||
      wouldCompleteRow ||
      now - lastWrite >= STATE_DB_WRITE_INTERVAL_MS;

    if (!shouldFlushDb) {
      return null;
    }
    this.lastDbWriteAt.set(dbKey, now);
    return this.playbackService.updateState(user.id, mediaId, {
      positionSeconds: body.positionSeconds,
      durationSeconds: body.durationSeconds,
      mediaFileId: body.mediaFileId,
      episodeId: body.episodeId,
    });
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

  /** Mark every episode of a single season as watched (or unwatched). */
  @Post('media/:mediaId/seasons/:seasonId/toggle-watched')
  toggleSeasonWatched(
    @Req() req: Request,
    @Param('mediaId', ParseIntPipe) mediaId: number,
    @Param('seasonId', ParseIntPipe) seasonId: number,
    @Body() body: { watched: boolean },
  ) {
    const user = req.user as User;
    return this.playbackService.toggleSeasonWatched(
      user.id,
      mediaId,
      seasonId,
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
