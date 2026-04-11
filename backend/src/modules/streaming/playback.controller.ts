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
import { User } from '../users/entities/user.entity';

@Controller('playback')
@UseGuards(JwtOrApiKeyGuard)
export class PlaybackController {
  constructor(private readonly playbackService: PlaybackService) {}

  @Get('watched-ids')
  watchedIds(@Req() req: Request) {
    const user = req.user as User;
    return this.playbackService.getWatchedMediaIds(user.id);
  }

  @Get('continue-watching')
  continueWatching(@Req() req: Request) {
    const user = req.user as User;
    return this.playbackService.getContinueWatching(user.id);
  }

  @Get('history')
  history(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const user = req.user as User;
    return this.playbackService.getHistory(
      user.id,
      Math.max(1, Number(page) || 1),
      Math.min(100, Math.max(1, Number(limit) || 25)),
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
