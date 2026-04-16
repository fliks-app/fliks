import {
  Controller,
  Get,
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
import { InappDownloadsService } from './inapp-downloads.service';
import { User } from '../users/entities/user.entity';

@Controller('downloads')
@UseGuards(JwtOrApiKeyGuard)
export class InappDownloadsController {
  constructor(private readonly downloads: InappDownloadsService) {}

  @Get('qualities/:mediaFileId')
  getQualities(
    @Req() req: Request,
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
  ) {
    return this.downloads.getAvailableQualities(mediaFileId, req.user as User);
  }

  @Post()
  create(
    @Req() req: Request,
    @Body()
    body: {
      mediaFileId: number;
      quality: string;
      deviceId?: string;
      deviceProfile?: {
        supportsHdr?: boolean;
        audioCodecs?: string[];
        videoCodecs?: string[];
        maxAudioChannels?: number;
      };
    },
  ) {
    const user = req.user as User;
    return this.downloads.create(
      user,
      body.mediaFileId,
      body.quality,
      body.deviceProfile,
      body.deviceId,
    );
  }

  @Get()
  list(@Req() req: Request, @Query('deviceId') deviceId?: string) {
    const user = req.user as User;
    return this.downloads.list(user.id, deviceId);
  }

  // --- Catch-all single resource AFTER sub-routes ---

  @Get(':id')
  getOne(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    const user = req.user as User;
    return this.downloads.getOne(user.id, id);
  }

  @Post(':id/retry')
  retry(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: {
      deviceProfile?: {
        supportsHdr?: boolean;
        audioCodecs?: string[];
        videoCodecs?: string[];
        maxAudioChannels?: number;
      };
    },
  ) {
    const user = req.user as User;
    return this.downloads.retry(user.id, id, body.deviceProfile);
  }

  @Post(':id/ack')
  async ackDownloaded(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const user = req.user as User;
    await this.downloads.ackDownloaded(user.id, id);
  }

  @Delete(':id')
  async remove(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    const user = req.user as User;
    await this.downloads.delete(user.id, id);
  }
}
