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
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';

const execFileAsync = promisify(execFile);
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { StreamingService, ResolvedFile } from './streaming.service';
import { SubtitleStreamService } from './subtitle-stream.service';
import {
  TranscodingService,
  PROFILES,
  SessionContext,
} from './transcoding.service';
import { ThumbnailService } from './thumbnail.service';
import { StreamBuilderService } from './stream-builder.service';
import { ActiveStreamTracker } from './active-stream-tracker.service';
import { SubtitleBurnInService } from './subtitle-burn-in.service';
import { DeviceProfileDto } from './dto/device-profile.dto';

const VALID_QUALITIES = new Set([...PROFILES.map((p) => p.name), 'remux']);
const SEG_DURATION = 2;

/** Generate a VOD HLS playlist for a given duration and segment URL pattern. */
function buildVodPlaylist(
  duration: number,
  segmentUrl: (index: string) => string,
  initUrl?: string,
): string {
  const segCount = Math.ceil(duration / SEG_DURATION);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${SEG_DURATION}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ];
  if (initUrl) {
    lines.push(`#EXT-X-MAP:URI="${initUrl}"`);
  }
  for (let i = 0; i < segCount; i++) {
    const segLen = Math.min(SEG_DURATION, duration - i * SEG_DURATION);
    lines.push(`#EXTINF:${segLen.toFixed(3)},`);
    lines.push(segmentUrl(String(i).padStart(4, '0')));
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

function firstQueryString(
  query: Request['query'],
  key: string,
): string | undefined {
  const v = query[key];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

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
    private readonly thumbnailService: ThumbnailService,
  ) {}

  private buildSessionContext(
    req: Request,
    resolved: ResolvedFile,
    mediaFileId: number,
  ): SessionContext {
    const user = req.user;
    const si = resolved.mediaFile.streamInfo;
    return {
      userId: user?.id,
      username: user?.username,
      mediaTitle: resolved.media?.title,
      mediaType: resolved.media?.type,
      posterUrl: resolved.media?.posterUrl ?? null,
      transcodeReasons:
        this.activeStreamTracker.getTranscodeReasons(mediaFileId),
      tonemap: this.activeStreamTracker.getTonemapping(mediaFileId),
      burnInSubtitle: this.activeStreamTracker.getBurnIn(mediaFileId),
      audioStreamIndex:
        this.activeStreamTracker.getAudioStreamIndex(mediaFileId),
      crop: si?.video?.[0]?.crop ?? undefined,
      // videoOnly only makes sense with fMP4 (var_stream_map produces separate audio).
      // For TS (Cast), audio must stay muxed in the video stream.
      videoOnly:
        this.activeStreamTracker.getAudioStreamCount(mediaFileId) > 1 &&
        this.activeStreamTracker.getFmp4Supported(mediaFileId),
      // Pass audio stream info for var_stream_map (single FFmpeg, multi-output)
      audioStreams:
        this.activeStreamTracker.getAudioStreamCount(mediaFileId) > 1
          ? (si?.audio as { language?: string; title?: string }[]) ?? []
          : undefined,
      useFmp4: this.activeStreamTracker.getFmp4Supported(mediaFileId),
    };
  }

  /** Resolve file duration from streamInfo or by probing with ffprobe. */
  private async resolveDuration(
    mediaFileId: number,
    absolutePath: string,
    streamInfo: { durationSeconds?: number } | null | undefined,
  ): Promise<number> {
    let duration = streamInfo?.durationSeconds ?? 0;
    if (!duration) {
      try {
        const { stdout } = await execFileAsync(
          'ffprobe',
          [
            '-v',
            'error',
            '-show_entries',
            'format=duration',
            '-of',
            'csv=p=0',
            absolutePath,
          ],
          { timeout: 10_000 },
        );
        duration = parseFloat(String(stdout).trim()) || 0;
      } catch (err) {
        this.log.warn(
          `Failed to probe duration for MediaFile #${mediaFileId}: ${err}`,
        );
      }
    }
    return duration;
  }

  /** Current hardware acceleration type detected by the server. */
  @Get('info/hw-accel')
  hwAccelInfo() {
    return { hwAccel: this.transcodingService.getDetectedHwAccel() };
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
    const token = firstQueryString(req.query, 'token');
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
    const burnInSubtitleRaw = firstQueryString(req.query, 'burnInSubtitleId');
    const burnInSubtitleId = burnInSubtitleRaw
      ? parseInt(burnInSubtitleRaw, 10)
      : undefined;
    const audioStreamRaw = firstQueryString(req.query, 'audioStreamIndex');
    const audioStreamIndex =
      audioStreamRaw != null ? parseInt(audioStreamRaw, 10) : undefined;
    const result = this.streamBuilder.evaluate(
      resolved,
      deviceProfile,
      tokenParam,
      burnInSubtitleId,
    );
    // Cache transcode reasons for the admin dashboard
    if (result.transcodeReasons.length) {
      this.activeStreamTracker.setTranscodeReasons(
        mediaFileId,
        result.transcodeReasons,
      );
    }
    this.activeStreamTracker.setTonemapping(mediaFileId, result.tonemapping);
    // Cache burn-in info for HLS endpoints
    if (burnInSubtitleId) {
      this.subtitleBurnIn
        .resolve(burnInSubtitleId, mediaFileId)
        .then((info) => {
          const filter = this.subtitleBurnIn.buildFilter(info);
          this.activeStreamTracker.setBurnIn(mediaFileId, {
            filter,
            streamIndex: info.streamIndex,
            type: info.type,
          });
        })
        .catch(() => {});
    } else {
      this.activeStreamTracker.setBurnIn(mediaFileId, undefined);
    }
    this.activeStreamTracker.setAudioStreamIndex(mediaFileId, audioStreamIndex);
    this.activeStreamTracker.setMultiAudioMuxed(
      mediaFileId,
      deviceProfile.supportsMultiAudioMuxed ?? false,
    );
    // Use TS for single-audio files (faster startup: no init.mp4 needed).
    // Keep fMP4 for multi-audio (required for var_stream_map / EXT-X-MEDIA).
    const audioCount = resolved.mediaFile.streamInfo?.audio?.length ?? 1;
    const clientSupportsFmp4 = deviceProfile.supportsHlsFmp4 ?? true;
    const useFmp4 = audioCount > 1 && clientSupportsFmp4;
    this.activeStreamTracker.setFmp4Supported(mediaFileId, useFmp4);

    // Include duration so the player can skip ffprobe in hlsPlaylist
    const duration = resolved.mediaFile.streamInfo?.durationSeconds ?? 0;
    return { ...result, durationSeconds: duration };
  }

  // ---------------------------------------------------------------------------
  // Thumbnail sprite endpoints
  // ---------------------------------------------------------------------------

  @Get(':mediaFileId/thumbnails/sprite.json')
  async thumbnailMeta(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Res() res: Response,
  ) {
    const resolved = await this.streamingService.resolveFile(mediaFileId);
    const duration = resolved.mediaFile.streamInfo?.durationSeconds;
    if (!duration) return res.status(404).json({ error: 'no duration' });

    const meta = await this.thumbnailService.getOrGenerate(
      mediaFileId,
      resolved.absolutePath,
      duration,
      resolved.media.title,
    );
    if (!meta) return res.status(404).json({ error: 'generation failed' });

    res.set('Cache-Control', 'public, max-age=86400');
    res.json(meta);
  }

  @Get(':mediaFileId/thumbnails/sprite.jpg')
  async thumbnailSprite(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Res() res: Response,
  ) {
    const resolved = await this.streamingService.resolveFile(mediaFileId);
    const duration = resolved.mediaFile.streamInfo?.durationSeconds;
    if (!duration) return res.status(404).end();

    const meta = await this.thumbnailService.getOrGenerate(
      mediaFileId,
      resolved.absolutePath,
      duration,
      resolved.media.title,
    );
    if (!meta) return res.status(404).end();

    const spritePath = this.thumbnailService.getSpritePath(mediaFileId);
    if (!fs.existsSync(spritePath)) return res.status(404).end();

    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Content-Type', 'image/jpeg');
    res.sendFile(spritePath);
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
    const si = resolved.mediaFile.streamInfo;
    const v = si?.video?.[0];
    const crop = v?.crop;
    // Use cropped dimensions if crop is active, otherwise original
    const w = crop?.width ?? v?.width ?? 1920;
    const h = crop?.height ?? v?.height ?? 1080;

    const token = firstQueryString(req.query, 'token');
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';

    const includeRemux = firstQueryString(req.query, 'remux') === '1';
    const sourceBitrate = (v?.bitRate ?? 0) + (si?.audio?.[0]?.bitRate ?? 0);
    const audioStreams: { language?: string; title?: string }[] =
      si?.audio ?? [];
    // Use EXT-X-MEDIA only when the client needs it (Shaka on web) AND supports fMP4.
    // Native players (ExoPlayer/AVPlayer) handle multi-audio from muxed TS.
    // Cast (TS) can't handle separate fMP4 audio renditions.
    const clientMuxesAudio =
      this.activeStreamTracker.getMultiAudioMuxed(mediaFileId);
    const fmp4Supported =
      this.activeStreamTracker.getFmp4Supported(mediaFileId);
    const useExtXMedia =
      audioStreams.length > 1 && !clientMuxesAudio && fmp4Supported;
    const playlist = this.transcodingService.generateMasterPlaylist(
      mediaFileId,
      w,
      h,
      tokenParam,
      includeRemux,
      sourceBitrate || undefined,
      useExtXMedia ? audioStreams : undefined,
    );

    this.activeStreamTracker.setAudioStreamCount(
      mediaFileId,
      audioStreams.length,
    );

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(playlist);
  }

  // Subtitle VTT routes MUST be registered before :mediaFileId/:quality/* — otherwise
  // paths like /123/subtitles/456 match :quality=:segment and fail with "Invalid quality: subtitles".

  /** Extract an embedded subtitle stream as WebVTT (before :subtitleId so "embedded" is not parsed as id). */
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

  // ---------------------------------------------------------------------------
  // Audio-only HLS endpoints (multi-audio EXT-X-MEDIA renditions)
  // Must be registered BEFORE :quality/:segment to avoid route conflicts.
  // ---------------------------------------------------------------------------

  /** Audio rendition playlist — segment list for a specific audio track. */
  @Get(':mediaFileId/audio/:audioIndex/index.m3u8')
  async hlsAudioPlaylist(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Param('audioIndex', ParseIntPipe) audioIndex: number,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const resolved = await this.streamingService.resolveFile(mediaFileId);
    const duration = await this.resolveDuration(
      mediaFileId,
      resolved.absolutePath,
      resolved.mediaFile.streamInfo,
    );
    if (!duration) {
      res.status(404).send('Duration unknown');
      return;
    }

    // With var_stream_map, audio is produced by the video session — no separate
    // audio session needed. Only start one as fallback for single-audio files.
    const multiAudio =
      this.activeStreamTracker.getAudioStreamCount(mediaFileId) > 1;
    if (!multiAudio) {
      const user = req.user;
      void this.transcodingService.getOrCreateAudioSession(
        mediaFileId,
        audioIndex,
        resolved.absolutePath,
        0,
        { userId: user?.id },
      );
    }

    const token = firstQueryString(req.query, 'token');
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
    const basePath = `/api/stream/${mediaFileId}/audio/${audioIndex}`;
    const playlist = buildVodPlaylist(
      duration,
      (seg) => `${basePath}/seg-${seg}.m4s${tokenParam}`,
      `${basePath}/init_${audioIndex + 1}.mp4${tokenParam}`,
    );

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(playlist);
  }

  /** Audio rendition file — serves fMP4 init segment or audio segment. */
  @Get(':mediaFileId/audio/:audioIndex/:segment')
  async hlsAudioSegment(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Param('audioIndex', ParseIntPipe) audioIndex: number,
    @Param('segment') segment: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const AUDIO_SEG_RE = /^(init(_\d+)?\.mp4|seg-\d{3,4}\.m4s)$/;
    if (!AUDIO_SEG_RE.test(segment)) {
      throw new BadRequestException(`Invalid audio segment name: ${segment}`);
    }

    const resolved = await this.streamingService.resolveFile(mediaFileId);

    const segMatch = segment.match(/seg-(\d+)\.m4s/);
    const segIndex = segMatch ? parseInt(segMatch[1], 10) : 0;

    const user = req.user;

    // With var_stream_map, audio is in the SAME session as video (subdir N+1).
    // Fall back to separate audio session if the video session doesn't have it.
    const videoSession = this.transcodingService.getExistingSession(
      mediaFileId,
      user?.id,
    );
    const varStreamPath = videoSession
      ? `${audioIndex + 1}/${segment}`
      : null;

    let segPath: string | null = null;

    if (videoSession && varStreamPath) {
      segPath = await this.transcodingService.getSegmentPath(
        videoSession,
        varStreamPath,
      );
    }

    // Fallback: separate audio session (for non-var_stream_map setups)
    if (!segPath) {
      const audioSession = await this.transcodingService.getOrCreateAudioSession(
        mediaFileId,
        audioIndex,
        resolved.absolutePath,
        segIndex,
        { userId: user?.id },
      );
      segPath = await this.transcodingService.getSegmentPath(
        audioSession,
        segment,
      );
    }
    if (!segPath) {
      res.status(404).send('Segment not found');
      return;
    }

    const contentType = segment === 'init.mp4'
      ? 'video/mp4'
      : 'video/iso.segment';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    const stream = fs.createReadStream(segPath);
    stream.on('error', () => { if (!res.headersSent) res.status(404).end(); });
    stream.pipe(res);
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
    // Use client-provided duration (from playbackInfo) to skip ffprobe
    const durationHint = firstQueryString(req.query, 'duration');
    const duration = (durationHint ? parseFloat(durationHint) : 0)
      || await this.resolveDuration(
        mediaFileId,
        resolved.absolutePath,
        resolved.mediaFile.streamInfo,
      );
    if (!duration) {
      res.status(404).send('Duration unknown — rescan the file first');
      return;
    }

    // No pre-start here: Shaka loads ALL variant playlists in parallel,
    // and pre-starting would create a session at whichever quality arrives first (often 360p).
    // The session is created on first actual segment request (with the correct quality
    // selected by the frontend's ABR lock).
    // Exception: Cast passes startAt for resume position — pre-start for Cast/remux only.
    const startAtRaw = firstQueryString(req.query, 'startAt');
    if (startAtRaw) {
      const existing = this.transcodingService.getExistingSession(
        mediaFileId,
        req.user?.id,
      );
      if (!existing || existing.process.exitCode !== null) {
        const startAtSec = parseInt(startAtRaw, 10);
        const startSegment = startAtSec > 0 ? Math.floor(startAtSec / 6) : 0;
        const ctx = this.buildSessionContext(req, resolved, mediaFileId);
        if (quality === 'remux') {
          const copyAudio =
            firstQueryString(req.query, 'copyAudio') !== 'false';
          void this.transcodingService.getOrCreateRemuxSession(
            mediaFileId,
            resolved.absolutePath,
            copyAudio,
            startSegment,
            ctx,
          );
        } else {
          void this.transcodingService.getOrCreateSession(
            mediaFileId,
            quality,
            resolved.absolutePath,
            startSegment,
            ctx,
          );
        }
      }
    }

    const token = firstQueryString(req.query, 'token');
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
    const basePath = `/api/stream/${mediaFileId}/${quality}`;
    const useFmp4 = this.activeStreamTracker.getFmp4Supported(mediaFileId);
    // var_stream_map (subdirectories) only active with fMP4 + multi-audio
    const multiAudio =
      this.activeStreamTracker.getAudioStreamCount(mediaFileId) > 1 && useFmp4;

    let playlist: string;
    if (useFmp4) {
      const initName = multiAudio ? 'init_0.mp4' : 'init.mp4';
      playlist = buildVodPlaylist(
        duration,
        (seg) => `${basePath}/seg-${seg}.m4s${tokenParam}`,
        `${basePath}/${initName}${tokenParam}`,
      );
    } else {
      // MPEG-TS for Cast (no init segment needed)
      playlist = buildVodPlaylist(
        duration,
        (seg) => `${basePath}/seg-${seg}.ts${tokenParam}`,
      );
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(playlist);
  }

  /** HLS segment — serves a transcoded .ts/.m4s segment or fMP4 init. */
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
    const VIDEO_SEG_RE = /^(seg-\d{3,4}\.(ts|m4s)|init(_\d+)?\.mp4)$/;
    if (!VIDEO_SEG_RE.test(segment)) {
      throw new BadRequestException(`Invalid segment name: ${segment}`);
    }

    const resolved = await this.streamingService.resolveFile(mediaFileId);

    // For init.mp4: serve from existing session without triggering quality changes.
    if (segment.startsWith('init')) {
      const existing = this.transcodingService.getExistingSession(
        mediaFileId,
        req.user?.id,
      );
      if (existing) {
        const fmp4 = this.activeStreamTracker.getFmp4Supported(mediaFileId);
        const ma = this.activeStreamTracker.getAudioStreamCount(mediaFileId) > 1 && fmp4;
        const initFile = ma ? `0/${segment}` : segment;
        const initPath = await this.transcodingService.getSegmentPath(
          existing,
          initFile,
        );
        if (initPath) {
          res.setHeader('Content-Type', 'video/mp4');
          res.setHeader('Access-Control-Allow-Origin', '*');
          const initStream = fs.createReadStream(initPath);
          initStream.on('error', () => { if (!res.headersSent) res.status(404).end(); });
          initStream.pipe(res);
          return;
        }
      }
      // No session yet — fall through to create one
    }

    const segMatch = segment.match(/seg-(\d+)\.(ts|m4s)/);
    const segIndex = segMatch ? parseInt(segMatch[1], 10) : 0;

    const ctx = this.buildSessionContext(req, resolved, mediaFileId);
    const session =
      quality === 'remux'
        ? await this.transcodingService.getOrCreateRemuxSession(
            mediaFileId,
            resolved.absolutePath,
            true,
            segIndex,
            ctx,
          )
        : await this.transcodingService.getOrCreateSession(
            mediaFileId,
            quality,
            resolved.absolutePath,
            segIndex,
            ctx,
          );

    // With var_stream_map (fMP4 + multi-audio), video segments are in subdirectory "0/"
    const varStreamMap =
      this.activeStreamTracker.getAudioStreamCount(mediaFileId) > 1 &&
      this.activeStreamTracker.getFmp4Supported(mediaFileId);
    const segName = varStreamMap ? `0/${segment}` : segment;

    const segPath = await this.transcodingService.getSegmentPath(
      session,
      segName,
    );
    if (!segPath) {
      res.status(404).send('Segment not found');
      return;
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const stream = fs.createReadStream(segPath);
    stream.on('error', () => { if (!res.headersSent) res.status(404).end(); });
    stream.pipe(res);
  }

  // ---------------------------------------------------------------------------
  // Session cleanup
  // ---------------------------------------------------------------------------

  /** Stop the transcoding session for this user + media file (called on player close / page unload). */
  @Delete(':mediaFileId/sessions')
  async stopSessions(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Req() req: Request,
  ) {
    const user = req.user;
    await this.transcodingService.killSession(mediaFileId, user?.id);
    if (user) {
      this.activeStreamTracker.unregister(user.id, mediaFileId);
    }
    return { ok: true };
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
    const user = req.user;
    if (user) {
      this.activeStreamTracker.register(
        user.id,
        user.username,
        mediaFileId,
        resolved.media?.title ?? '',
        resolved.media?.type ?? '',
        resolved.media?.posterUrl ?? null,
      );
    }

    const duration = resolved.mediaFile.streamInfo?.durationSeconds;
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
