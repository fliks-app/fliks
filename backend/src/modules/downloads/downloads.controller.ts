import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  Res,
  UseGuards,
  ParseIntPipe,
  NotFoundException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { DownloadsService } from './downloads.service';
import { User } from '../users/entities/user.entity';
import * as fs from 'fs';
import * as path from 'path';

@Controller('downloads')
@UseGuards(JwtOrApiKeyGuard)
export class DownloadsController {
  constructor(private readonly downloads: DownloadsService) {}

  @Get('qualities/:mediaFileId')
  getQualities(@Param('mediaFileId', ParseIntPipe) mediaFileId: number) {
    return this.downloads.getAvailableQualities(mediaFileId);
  }

  @Post()
  create(
    @Req() req: Request,
    @Body() body: {
      mediaFileId: number;
      quality: string;
      deviceProfile?: {
        supportsHdr?: boolean;
        audioCodecs?: string[];
        maxAudioChannels?: number;
      };
    },
  ) {
    const user = req.user as User;
    return this.downloads.create(user.id, body.mediaFileId, body.quality, body.deviceProfile);
  }

  @Get()
  list(@Req() req: Request) {
    const user = req.user as User;
    return this.downloads.list(user.id);
  }

  @Get(':id')
  getOne(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    const user = req.user as User;
    return this.downloads.getOne(user.id, id);
  }

  @Get(':id/file')
  async getFile(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const user = req.user as User;
    const filePath = await this.downloads.getFilePath(user.id, id);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException(`Download file not found`);
    }
    const stat = fs.statSync(filePath);
    const filename = path.basename(filePath);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"`,
    );

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', end - start + 1);
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      fs.createReadStream(filePath).pipe(res);
    }
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
    const filePath = path.join(
      path.dirname(task.outputPath || ''),
      filename,
    );
    res.setHeader('Content-Type', 'text/vtt');
    fs.createReadStream(filePath).pipe(res);
  }

  @Post(':id/retry')
  retry(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { deviceProfile?: { supportsHdr?: boolean; audioCodecs?: string[]; maxAudioChannels?: number } },
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
