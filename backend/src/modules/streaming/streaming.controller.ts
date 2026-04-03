import {
  Controller,
  Get,
  Param,
  Req,
  Res,
  ParseIntPipe,
  UseGuards,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { StreamingService } from './streaming.service';
import { SubtitleStreamService } from './subtitle-stream.service';
import { TranscodingService } from './transcoding.service';

@Controller('stream')
@UseGuards(JwtOrApiKeyGuard)
export class StreamingController {
  private readonly log = new Logger(StreamingController.name);

  constructor(
    private readonly streamingService: StreamingService,
    private readonly subtitleStreamService: SubtitleStreamService,
    private readonly transcodingService: TranscodingService,
  ) {}

  /** Current hardware acceleration type detected by the server. */
  @Get('info/hw-accel')
  hwAccelInfo() {
    return { hwAccel: this.transcodingService.getDetectedHwAccel() };
  }

  // ---------------------------------------------------------------------------
  // HLS endpoints (must be BEFORE the generic :mediaFileId route)
  // ---------------------------------------------------------------------------

  /** HLS master playlist — lists available quality variants. */
  @Get(':mediaFileId/master.m3u8')
  async hlsMaster(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const resolved = await this.streamingService.resolveFile(mediaFileId);
    const si = resolved.mediaFile.streamInfo as any;
    const v = si?.video?.[0];
    const w = v?.width ?? 1920;
    const h = v?.height ?? 1080;

    const token = (req.query as any).token;
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';

    const playlist = this.transcodingService.generateMasterPlaylist(
      mediaFileId, w, h, tokenParam,
    );

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(playlist);
  }

  /** HLS variant playlist — pre-computed segment list based on known duration. */
  @Get(':mediaFileId/:quality/index.m3u8')
  async hlsPlaylist(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Param('quality') quality: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const resolved = await this.streamingService.resolveFile(mediaFileId);
    const si = resolved.mediaFile.streamInfo as any;
    let duration = si?.durationSeconds ?? 0;

    // If duration unknown, probe it on the fly
    if (!duration) {
      try {
        const { execFile: ef } = require('child_process');
        const { promisify } = require('util');
        const exec = promisify(ef);
        const { stdout } = await exec('ffprobe', [
          '-v', 'error', '-show_entries', 'format=duration',
          '-of', 'csv=p=0', resolved.absolutePath,
        ], { timeout: 10_000 });
        duration = parseFloat(stdout.trim()) || 0;
      } catch { /* ignore */ }
    }

    if (!duration) {
      res.status(404).send('Duration unknown — rescan the file first');
      return;
    }

    // Start transcoding in the background (don't wait)
    void this.transcodingService.getOrCreateSession(
      mediaFileId, quality, resolved.absolutePath,
    );

    const token = (req.query as any).token;
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';

    // Generate a complete playlist upfront so shaka sees a VOD stream with seek support
    const segDuration = 6;
    const segCount = Math.ceil(duration / segDuration);
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${segDuration}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
    ];

    for (let i = 0; i < segCount; i++) {
      const remaining = duration - i * segDuration;
      const segLen = Math.min(segDuration, remaining);
      lines.push(`#EXTINF:${segLen.toFixed(3)},`);
      lines.push(`/api/stream/${mediaFileId}/${quality}/seg-${String(i).padStart(3, '0')}.ts${tokenParam}`);
    }
    lines.push('#EXT-X-ENDLIST');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(lines.join('\n'));
  }

  /** HLS segment — serves a transcoded .ts segment. */
  @Get(':mediaFileId/:quality/:segment')
  async hlsSegment(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Param('quality') quality: string,
    @Param('segment') segment: string,
    @Res() res: Response,
  ) {
    const resolved = await this.streamingService.resolveFile(mediaFileId);

    // Parse segment index (seg-042.ts → 42)
    const segMatch = segment.match(/seg-(\d+)\.ts/);
    const segIndex = segMatch ? parseInt(segMatch[1], 10) : 0;

    const session = await this.transcodingService.getOrCreateSession(
      mediaFileId, quality, resolved.absolutePath, segIndex,
    );

    const segPath = await this.transcodingService.getSegmentPath(session, segment);
    if (!segPath) {
      res.status(404).send('Segment not found');
      return;
    }

    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Access-Control-Allow-Origin', '*');
    fs.createReadStream(segPath).pipe(res);
  }

  // ---------------------------------------------------------------------------
  // Subtitle endpoints
  // ---------------------------------------------------------------------------

  /** Serve an external subtitle as WebVTT. */
  @Get(':mediaFileId/subtitles/:subtitleId')
  async subtitle(
    @Param('subtitleId', ParseIntPipe) subtitleId: number,
    @Res() res: Response,
  ) {
    const vtt = await this.subtitleStreamService.getSubtitleAsVtt(subtitleId);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(vtt);
  }

  /** Extract an embedded subtitle stream as WebVTT. */
  @Get(':mediaFileId/subtitles/embedded/:streamIndex')
  async embeddedSubtitle(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Param('streamIndex', ParseIntPipe) streamIndex: number,
    @Res() res: Response,
  ) {
    const stream = await this.subtitleStreamService.extractEmbeddedSubtitle(
      mediaFileId,
      streamIndex,
    );
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    stream.pipe(res);
  }

  // ---------------------------------------------------------------------------
  // Direct play (generic route — must be LAST)
  // ---------------------------------------------------------------------------

  /** Direct play a media file with Range request support. */
  @Get(':mediaFileId')
  async stream(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const resolved = await this.streamingService.resolveFile(mediaFileId);

    const duration = (resolved.mediaFile.streamInfo as any)?.durationSeconds;
    if (duration) {
      res.setHeader('X-Content-Duration', String(duration));
      res.setHeader('Access-Control-Expose-Headers', 'X-Content-Duration');
    }

    const range = req.headers.range;
    const fileSize = resolved.size;
    const contentType = resolved.contentType;
    const absolutePath = resolved.absolutePath;

    if (!range) {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', fileSize);
      res.setHeader('Accept-Ranges', 'bytes');
      fs.createReadStream(absolutePath).pipe(res);
      return;
    }

    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.status(206);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', chunkSize);

    fs.createReadStream(absolutePath, { start, end }).pipe(res);
  }
}
