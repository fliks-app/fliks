import {
  Controller,
  Get,
  Put,
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

  @Delete(':mediaFileId')
  deleteState(
    @Req() req: Request,
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
  ) {
    const user = req.user as User;
    return this.playbackService.deleteState(user.id, mediaFileId);
  }
}
