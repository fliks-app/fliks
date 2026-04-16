import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  ParseIntPipe,
  NotFoundException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { InappDownloadsService } from './inapp-downloads.service';
import { User } from '../users/entities/user.entity';
import * as fs from 'fs';
import * as path from 'path';

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

  // --- Sub-resource routes MUST come before the catch-all `GET :id` ---

  @Get(':id/file')
  async getFile(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const user = req.user as User;
    const task = await this.downloads.getOne(user.id, id);

    if (task.status !== 'ready') {
      res.status(400).json({ message: 'Download not ready' });
      return;
    }

    if (!task.sessionDir || !fs.existsSync(task.sessionDir)) {
      throw new NotFoundException('Session directory not found');
    }
    const dir = task.sessionDir;
    const initPath = path.join(dir, 'init.mp4');
    const segFiles = fs
      .readdirSync(dir)
      .filter((f: string) => /^seg-\d+\.m4s$/.test(f))
      .sort();

    let totalSize = 0;
    const files = [initPath, ...segFiles.map((f: string) => path.join(dir, f))];
    for (const f of files) {
      totalSize += fs.statSync(f).size;
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', totalSize);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="download-${id}.mp4"`,
    );

    const streamNext = (index: number) => {
      if (index >= files.length) {
        res.end();
        return;
      }
      const stream = fs.createReadStream(files[index]);
      stream.on('end', () => streamNext(index + 1));
      stream.on('error', () => res.end());
      stream.pipe(res, { end: false });
    };
    streamNext(0);
  }

  @Get(':id/subtitle/:filename')
  async getSubtitle(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id', ParseIntPipe) id: number,
    @Param('filename') filename: string,
  ) {
    const user = req.user as User;
    const task = await this.downloads.getOne(user.id, id);
    if (!task.subtitles?.some((s) => s.filename === filename)) {
      res.status(404).send('Subtitle not found');
      return;
    }
    const cachePath = task.sessionDir
      ? path.dirname(task.sessionDir)
      : '/tmp/fliks-downloads';
    const filePath = path.join(cachePath, filename);
    if (!fs.existsSync(filePath)) {
      res.status(404).send('Subtitle file not found');
      return;
    }
    res.setHeader('Content-Type', 'text/vtt');
    fs.createReadStream(filePath).pipe(res);
  }

  @Get(':id/segment/:filename')
  async getSegment(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id', ParseIntPipe) id: number,
    @Param('filename') filename: string,
  ) {
    const user = req.user as User;
    const segPath = await this.downloads.getSegmentPath(user.id, id, filename);
    if (!fs.existsSync(segPath)) {
      throw new NotFoundException('Segment not found');
    }
    const mime = filename.endsWith('.mp4') ? 'video/mp4' : 'video/iso.segment';
    const stat = fs.statSync(segPath);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(segPath).pipe(res);
  }

  @Get(':id/status')
  async progressiveStatus(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const user = req.user as User;
    return this.downloads.getProgressiveStatus(user.id, id);
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
