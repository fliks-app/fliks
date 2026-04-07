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

  @Get('media/:mediaId')
  getMediaResumeInfo(
    @Req() req: Request,
    @Param('mediaId', ParseIntPipe) mediaId: number,
  ) {
    const user = req.user as User;
    return this.playbackService.getMediaResumeInfo(user.id, mediaId);
  }

  @Get(':mediaFileId')
  getState(
    @Req() req: Request,
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
  ) {
    const user = req.user as User;
    return this.playbackService.getState(user.id, mediaFileId);
  }

  @Put(':mediaFileId')
  updateState(
    @Req() req: Request,
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Body()
    body: {
      positionSeconds: number;
      durationSeconds: number;
      mediaId: number;
      episodeId?: number;
    },
  ) {
    const user = req.user as User;
    return this.playbackService.updateState(user.id, mediaFileId, body);
  }

  @Post(':mediaFileId/toggle-watched')
  toggleWatched(
    @Req() req: Request,
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Body() body: { mediaId: number; episodeId?: number },
  ) {
    const user = req.user as User;
    return this.playbackService.toggleWatched(
      user.id,
      mediaFileId,
      body.mediaId,
      body.episodeId,
    );
  }

  @Delete(':mediaFileId')
  deleteState(
    @Req() req: Request,
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
  ) {
    const user = req.user as User;
    return this.playbackService.deleteState(user.id, mediaFileId);
  }

  /** Remove a media from continue watching (marks all episodes as completed). */
  @Delete('hide/:mediaId')
  hideFromContinueWatching(
    @Req() req: Request,
    @Param('mediaId', ParseIntPipe) mediaId: number,
  ) {
    const user = req.user as User;
    return this.playbackService.hideFromContinueWatching(user.id, mediaId);
  }
}
