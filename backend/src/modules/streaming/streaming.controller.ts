import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
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
import { TranscodingService, PROFILES, SessionContext, BurnInSubtitle } from './transcoding.service';
import { StreamBuilderService } from './stream-builder.service';
import { ActiveStreamTracker } from './active-stream-tracker.service';
import { SubtitleBurnInService } from './subtitle-burn-in.service';
import { DeviceProfileDto } from './dto/device-profile.dto';
import { User } from '../users/entities/user.entity';

const VALID_QUALITIES = new Set([...PROFILES.map((p) => p.name), 'remux']);
const SEGMENT_RE = /^seg-\d{3,4}\.ts$/;

@Controller('stream')
@UseGuards(JwtOrApiKeyGuard)
export class StreamingController {
  private readonly log = new Logger(StreamingController.name);

  constructor(
    private readonly streamingService: StreamingService,
    private readonly subtitleStreamService: SubtitleStreamService,
    private readonly transcodingService: TranscodingService,
    private readonly streamBuilder: StreamBuilderService,
    private readonly activeStreamTracker: ActiveStreamTracker,
    private readonly subtitleBurnIn: SubtitleBurnInService,
  ) {}

  private buildSessionContext(req: Request, resolved: { media: any }, mediaFileId: number): SessionContext {
    const user = (req as any).user as User | undefined;
    return {
      userId: user?.id,
      username: user?.username,
      mediaTitle: resolved.media?.title,
      mediaType: resolved.media?.type,
      posterUrl: resolved.media?.posterUrl ?? null,
      transcodeReasons: this.activeStreamTracker.getTranscodeReasons(mediaFileId),
      tonemap: this.activeStreamTracker.getTonemapping(mediaFileId),
      burnInSubtitle: this.activeStreamTracker.getBurnIn(mediaFileId),
      audioStreamIndex: this.activeStreamTracker.getAudioStreamIndex(mediaFileId),
    };
  }

  /** Current hardware acceleration type detected by the server. */
  @Get('info/hw-accel')
  hwAccelInfo() {
    return { hwAccel: this.transcodingService.getDetectedHwAccel() };
  }

  /**
   * Server URL accessible from the LAN (for Chromecast).
   * Uses EXTERNAL_URL env var, or derives from the Host header.
   */
  @Get('info/server-url')
  serverUrl(@Req() req: Request) {
    if (process.env.EXTERNAL_URL) {
      return { url: process.env.EXTERNAL_URL.replace(/\/+$/, '') };
    }
    // Derive from Host header (works when browser accesses via LAN IP)
    const host = req.headers.host;
    if (host) {
      const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
      return { url: `${proto}://${host}` };
    }
    return { url: `http://localhost:${process.env.PORT || 3000}` };
  }

  /**
   * PlaybackInfo — the client sends its DeviceProfile, the server decides
   * how to play the file: DirectPlay, DirectStream (remux), or Transcode.
   */
  @Post(':mediaFileId/playback-info')
  async playbackInfo(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Body() deviceProfile: DeviceProfileDto,
    @Req() req: Request,
  ) {
    const resolved = await this.streamingService.resolveFile(mediaFileId);
    const token = (req.query as any).token;
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
    const burnInSubtitleId = (req.query as any).burnInSubtitleId
      ? parseInt((req.query as any).burnInSubtitleId, 10)
      : undefined;
    const audioStreamIndex = (req.query as any).audioStreamIndex != null
      ? parseInt((req.query as any).audioStreamIndex, 10)
      : undefined;
    const result = this.streamBuilder.evaluate(resolved, deviceProfile, tokenParam, burnInSubtitleId);
    // Cache transcode reasons for the admin dashboard
    if (result.transcodeReasons.length) {
      this.activeStreamTracker.setTranscodeReasons(mediaFileId, result.transcodeReasons);
    }
    this.activeStreamTracker.setTonemapping(mediaFileId, result.tonemapping);
    // Cache burn-in info for HLS endpoints
    if (burnInSubtitleId) {
      this.subtitleBurnIn.resolve(burnInSubtitleId, mediaFileId).then((info) => {
        const filter = this.subtitleBurnIn.buildFilter(info);
        this.activeStreamTracker.setBurnIn(mediaFileId, {
          filter,
          streamIndex: info.streamIndex,
          type: info.type,
        });
      }).catch(() => {});
    } else {
      this.activeStreamTracker.setBurnIn(mediaFileId, undefined);
    }
    this.activeStreamTracker.setAudioStreamIndex(mediaFileId, audioStreamIndex);
    return result;
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

    const includeRemux = (req.query as any).remux === '1';
    const sourceBitrate = (v?.bitRate ?? 0) + (si?.audio?.[0]?.bitRate ?? 0);
    const playlist = this.transcodingService.generateMasterPlaylist(
      mediaFileId, w, h, tokenParam, includeRemux, sourceBitrate || undefined,
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
    if (!VALID_QUALITIES.has(quality)) {
      throw new BadRequestException(`Invalid quality: ${quality}`);
    }
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
      } catch (err) {
        this.log.warn(`Failed to probe duration for MediaFile #${mediaFileId}: ${err}`);
      }
    }

    if (!duration) {
      res.status(404).send('Duration unknown — rescan the file first');
      return;
    }

    // Start transcoding/remuxing in the background (don't wait)
    const ctx = this.buildSessionContext(req, resolved, mediaFileId);
    if (quality === 'remux') {
      const copyAudio = (req.query as any).copyAudio !== 'false';
      void this.transcodingService.getOrCreateRemuxSession(
        mediaFileId, resolved.absolutePath, copyAudio, 0, ctx,
      );
    } else {
      void this.transcodingService.getOrCreateSession(
        mediaFileId, quality, resolved.absolutePath, 0, ctx,
      );
    }

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
      lines.push(`/api/stream/${mediaFileId}/${quality}/seg-${String(i).padStart(4, '0')}.ts${tokenParam}`);
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
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!VALID_QUALITIES.has(quality)) {
      throw new BadRequestException(`Invalid quality: ${quality}`);
    }
    if (!SEGMENT_RE.test(segment)) {
      throw new BadRequestException(`Invalid segment name: ${segment}`);
    }

    const resolved = await this.streamingService.resolveFile(mediaFileId);

    // Parse segment index (seg-042.ts → 42)
    const segMatch = segment.match(/seg-(\d+)\.ts/);
    const segIndex = segMatch ? parseInt(segMatch[1], 10) : 0;

    const ctx = this.buildSessionContext(req, resolved, mediaFileId);
    const session = quality === 'remux'
      ? await this.transcodingService.getOrCreateRemuxSession(
          mediaFileId, resolved.absolutePath, true, segIndex, ctx,
        )
      : await this.transcodingService.getOrCreateSession(
          mediaFileId, quality, resolved.absolutePath, segIndex, ctx,
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
  // Session cleanup
  // ---------------------------------------------------------------------------

  /** Stop all transcoding sessions for a media file (called on player close / page unload). */
  @Delete(':mediaFileId/sessions')
  stopSessions(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Req() req: Request,
  ) {
    this.transcodingService.killAllSessionsForFile(mediaFileId);
    const user = (req as any).user as User | undefined;
    if (user) {
      this.activeStreamTracker.unregister(user.id, mediaFileId);
    }
    return { ok: true };
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

    // Track direct play session
    const user = (req as any).user as User | undefined;
    if (user) {
      this.activeStreamTracker.register(
        user.id, user.username, mediaFileId,
        resolved.media?.title ?? '', resolved.media?.type ?? '',
        resolved.media?.posterUrl ?? null,
      );
    }

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
