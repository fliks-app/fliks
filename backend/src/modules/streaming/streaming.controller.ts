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
import { SettingsService } from '../settings/settings.service';

const execFileAsync = promisify(execFile);
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { User } from '../users/entities/user.entity';
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

/** Generate a VOD HLS playlist for a given duration and segment URL pattern. */
/** Default segment duration — overridden by admin streaming settings via tracker. */
let SEG_DURATION = 3;

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
    private readonly settingsService: SettingsService,
  ) {}

  /** Read streaming settings from DB with defaults. */
  private async getStreamingSettings() {
    const [
      format,
      duration,
      initTime,
      qsvPreset,
      qsvLookahead,
      qsvLowPower,
      qsvAdaptive,
    ] = await Promise.all([
      this.settingsService.get('streaming_segment_format'),
      this.settingsService.get('streaming_segment_duration'),
      this.settingsService.get('streaming_init_time'),
      this.settingsService.get('streaming_qsv_preset'),
      this.settingsService.get('streaming_qsv_lookahead'),
      this.settingsService.get('streaming_qsv_low_power'),
      this.settingsService.get('streaming_qsv_adaptive'),
    ]);
    return {
      segmentFormat: (format ?? 'auto') as 'auto' | 'ts' | 'fmp4',
      segmentDuration: parseFloat(duration ?? '3') || 3,
      initTime: parseFloat(initTime ?? '1') || 1,
      qsvPreset: (qsvPreset ?? 'faster') as
        | 'veryfast'
        | 'faster'
        | 'fast'
        | 'medium'
        | 'slow'
        | 'slower'
        | 'veryslow',
      // Booleans stored as 'true' / 'false' strings (SettingsService is text-only).
      qsvLookahead: qsvLookahead === 'true',
      qsvLowPower: qsvLowPower === 'true',
      // Default true when absent.
      qsvAdaptive: qsvAdaptive == null ? true : qsvAdaptive === 'true',
    };
  }

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
      // For TS, audio must stay muxed in the video stream.
      // Multi-audio handling depends on segment format:
      //   - fMP4: videoOnly + var_stream_map (separate audio renditions in
      //     subdirs) → Shaka can switch via EXT-X-MEDIA.
      //   - TS:   mapAllAudio muxes every audio track as distinct PIDs in a
      //     single TS stream → ExoPlayer/AVPlayer switch by PID natively.
      videoOnly:
        this.activeStreamTracker.getAudioStreamCount(mediaFileId) > 1 &&
        this.activeStreamTracker.getFmp4Supported(mediaFileId),
      mapAllAudio:
        this.activeStreamTracker.getAudioStreamCount(mediaFileId) > 1 &&
        !this.activeStreamTracker.getFmp4Supported(mediaFileId),
      // Pass audio stream info for both var_stream_map (fMP4) and
      // mapAllAudio (TS) — both paths need language metadata.
      audioStreams:
        this.activeStreamTracker.getAudioStreamCount(mediaFileId) > 1
          ? ((si?.audio as { language?: string; title?: string }[]) ?? [])
          : undefined,
      useFmp4: this.activeStreamTracker.getFmp4Supported(mediaFileId),
      encoderPreset: this.activeStreamTracker.getEncoderPreset(mediaFileId),
      qsvOptions: this.activeStreamTracker.getQsvOptions(),
      // Source framerate (e.g. "24", "23.976", "29.97") — used to compute an
      // accurate GOP so IDR frames fall on the same boundary regardless of
      // source fps. Falls back to 24 when unknown.
      sourceFps: parseFloat(si?.video?.[0]?.frameRate ?? '') || undefined,
      // ffprobe ran at import/rescan and the result is cached in streamInfo —
      // tell FFmpeg to skip its own redundant avformat_find_stream_info scan.
      trustedStreamInfo: !!si?.video?.[0]?.codec,
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
    const resolved = await this.streamingService.resolveFile(
      mediaFileId,
      req.user as User,
    );
    const token = firstQueryString(req.query, 'token');
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
    const burnInSubtitleRaw = firstQueryString(req.query, 'burnInSubtitleId');
    const burnInSubtitleId = burnInSubtitleRaw
      ? parseInt(burnInSubtitleRaw, 10)
      : undefined;
    const audioStreamRaw = firstQueryString(req.query, 'audioStreamIndex');
    const audioStreamIndex =
      audioStreamRaw != null ? parseInt(audioStreamRaw, 10) : undefined;

    // Compute segment format early — the stream builder needs it to decide
    // whether HDR passthrough is possible (HEVC requires fMP4 on iOS).
    const ss = await this.getStreamingSettings();
    const audioCount = resolved.mediaFile.streamInfo?.audio?.length ?? 1;
    const clientFmp4 = deviceProfile.supportsHlsFmp4 ?? true;
    let useFmp4: boolean;
    if (ss.segmentFormat === 'ts') useFmp4 = false;
    else if (ss.segmentFormat === 'fmp4') useFmp4 = clientFmp4;
    else useFmp4 = audioCount > 1 && clientFmp4; // auto: fMP4 for multi-audio only

    const result = this.streamBuilder.evaluate(
      resolved,
      deviceProfile,
      tokenParam,
      burnInSubtitleId,
      useFmp4,
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
    this.activeStreamTracker.setFmp4Supported(mediaFileId, useFmp4);
    this.activeStreamTracker.setStreamingDurations(
      ss.segmentDuration,
      ss.initTime,
    );
    // Update module-level constants used by buildVodPlaylist and transcoding
    SEG_DURATION = ss.segmentDuration;
    this.transcodingService.setSegmentDurations(
      ss.segmentDuration,
      ss.initTime,
    );

    // Persist encoder preset + QSV advanced options for downstream sessions.
    this.activeStreamTracker.setEncoderPreset(mediaFileId, ss.qsvPreset);
    this.activeStreamTracker.setQsvOptions({
      lookahead: ss.qsvLookahead,
      lowPower: ss.qsvLowPower,
      adaptive: ss.qsvAdaptive,
    });

    // Persist source→client codec compatibility so hlsMaster can pick a
    // smart-remux variant when the user's quality lock matches the source
    // resolution (and video codec is copy-compatible).
    this.activeStreamTracker.setCanCopyVideo(
      mediaFileId,
      result.videoCopyStream,
    );
    this.activeStreamTracker.setCanCopyAudio(
      mediaFileId,
      result.audioCopyStream,
    );
    const sv = resolved.mediaFile.streamInfo?.video?.[0];
    this.activeStreamTracker.setSourceDimensions(
      mediaFileId,
      sv?.width ?? 0,
      sv?.height ?? 0,
    );

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
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // ACL check only — do NOT trigger sprite generation from this endpoint.
    // Sprites are built at import/rescan (scheduler) or via the admin
    // regenerate button. Kicking off a CPU-heavy sprite extraction while the
    // user is starting playback slowed stream startup by 20+ seconds.
    await this.streamingService.resolveFile(mediaFileId, req.user as User);
    const meta = await this.thumbnailService.readExistingMeta(mediaFileId);
    if (!meta) return res.status(404).json({ error: 'sprite not generated' });

    res.set('Cache-Control', 'public, max-age=86400');
    res.json(meta);
  }

  @Get(':mediaFileId/thumbnails/sprite.jpg')
  async thumbnailSprite(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // Same rationale as thumbnailMeta — no on-demand generation here.
    await this.streamingService.resolveFile(mediaFileId, req.user as User);
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
    const resolved = await this.streamingService.resolveFile(
      mediaFileId,
      req.user as User,
    );
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
    // When the user explicitly picked an audio track (audioStreamIndex set in
    // the tracker), the variant only contains that one audio — no rendition
    // group makes sense, drop EXT-X-MEDIA so the player plays the muxed audio.
    const clientMuxesAudio =
      this.activeStreamTracker.getMultiAudioMuxed(mediaFileId);
    const fmp4Supported =
      this.activeStreamTracker.getFmp4Supported(mediaFileId);
    const userPickedAudio =
      this.activeStreamTracker.getAudioStreamIndex(mediaFileId) != null;
    const useExtXMedia =
      audioStreams.length > 1 &&
      !clientMuxesAudio &&
      fmp4Supported &&
      !userPickedAudio;
    const onlyQuality = firstQueryString(req.query, 'startQuality');

    // Smart remux: if the user's locked quality maps to a target height that
    // already matches the source height (±16 px), and the source video codec
    // is copy-compatible with the client (captured at playback-info time in
    // `canCopyVideo`), emit the remux variant instead of a transcode variant.
    // Saves a full video re-encode — zero GPU, instant startup.
    let smartRemux = false;
    if (
      onlyQuality &&
      onlyQuality !== 'auto' &&
      onlyQuality !== 'original' &&
      onlyQuality !== 'remux'
    ) {
      const profile = PROFILES.find((p) => p.name === onlyQuality);
      const canCopyVideo =
        this.activeStreamTracker.getCanCopyVideo(mediaFileId);
      const sourceH = this.activeStreamTracker.getSourceHeight(mediaFileId);
      const sourceW = this.activeStreamTracker.getSourceWidth(mediaFileId);
      if (profile && canCopyVideo && sourceW > 0 && sourceH > 0) {
        const targetW = Math.min(profile.maxWidth, sourceW);
        const rawH = (targetW * sourceH) / sourceW;
        const targetH = Math.floor(rawH / 16) * 16 || 16;
        if (Math.abs(sourceH - targetH) <= 16) {
          smartRemux = true;
          this.log.log(
            `Smart remux for file ${mediaFileId}: source ${sourceW}x${sourceH} ` +
              `matches requested ${onlyQuality}, skipping transcode`,
          );
        }
      }
    }

    const effectiveIncludeRemux = includeRemux || smartRemux;
    const effectiveOnlyQuality = smartRemux ? 'remux' : onlyQuality;

    const playlist = this.transcodingService.generateMasterPlaylist(
      mediaFileId,
      w,
      h,
      tokenParam,
      effectiveIncludeRemux,
      sourceBitrate || undefined,
      useExtXMedia ? audioStreams : undefined,
      effectiveOnlyQuality,
    );

    this.activeStreamTracker.setAudioStreamCount(
      mediaFileId,
      audioStreams.length,
    );

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(playlist);

    // Pre-spawn ffmpeg when we know the player will start at seg-0 (fresh
    // play, not resume). For resume the player seeks to a mid-file segment
    // which would kill this pre-spawned session — wasting the work and
    // adding a kill+restart penalty.
    const startAt = parseFloat(firstQueryString(req.query, 'startAt') ?? '0');
    if (
      effectiveOnlyQuality &&
      effectiveOnlyQuality !== 'auto' &&
      startAt === 0
    ) {
      const existing = this.transcodingService.getExistingSession(
        mediaFileId,
        req.user?.id,
      );
      if (!existing || existing.process.exitCode !== null) {
        const ctx = this.buildSessionContext(req, resolved, mediaFileId);
        if (
          effectiveOnlyQuality === 'remux' ||
          effectiveOnlyQuality === 'original'
        ) {
          const copyAudio =
            this.activeStreamTracker.getCanCopyAudio(mediaFileId);
          void this.transcodingService
            .getOrCreateRemuxSession(
              mediaFileId,
              resolved.absolutePath,
              copyAudio,
              0,
              ctx,
            )
            .catch(() => {});
        } else {
          void this.transcodingService
            .getOrCreateSession(
              mediaFileId,
              effectiveOnlyQuality,
              resolved.absolutePath,
              0,
              ctx,
            )
            .catch(() => {});
        }
      }
    }
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
    // Buffer the FFmpeg output so we can send Content-Length
    // (ExoPlayer needs it for subtitle loading)
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const vtt = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(vtt);
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
    const resolved = await this.streamingService.resolveFile(
      mediaFileId,
      req.user as User,
    );
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

    const segMatch = segment.match(/seg-(\d+)\.m4s/);
    const segIndex = segMatch ? parseInt(segMatch[1], 10) : 0;
    const user = req.user;

    // Fast path: try video session's var_stream_map subdir first (no DB query).
    const videoSession = this.transcodingService.getExistingSession(
      mediaFileId,
      user?.id,
    );

    let segPath: string | null = null;

    if (videoSession) {
      const varStreamPath = `${audioIndex + 1}/${segment}`;
      segPath = await this.transcodingService.getSegmentPath(
        videoSession,
        varStreamPath,
      );
    }

    // Fallback: separate audio session (needs DB for absolutePath).
    if (!segPath) {
      const resolved = await this.streamingService.resolveFile(
        mediaFileId,
        req.user as User,
      );
      const audioSession =
        await this.transcodingService.getOrCreateAudioSession(
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

    const contentType =
      segment === 'init.mp4' ? 'video/mp4' : 'video/iso.segment';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    const stream = fs.createReadStream(segPath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).end();
    });
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
    const resolved = await this.streamingService.resolveFile(
      mediaFileId,
      req.user as User,
    );
    // Use client-provided duration (from playbackInfo) to skip ffprobe
    const durationHint = firstQueryString(req.query, 'duration');
    const duration =
      (durationHint ? parseFloat(durationHint) : 0) ||
      (await this.resolveDuration(
        mediaFileId,
        resolved.absolutePath,
        resolved.mediaFile.streamInfo,
      ));
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

    // Fast path: if a session already exists, skip the DB query — we only
    // need resolveFile for absolutePath + context when creating a NEW session.
    // Saves ~15-25ms per segment (a 2h file = ~2400 segments = ~40s saved).
    const existing = this.transcodingService.getExistingSession(
      mediaFileId,
      req.user?.id,
    );

    // For init.mp4: serve from existing session without triggering quality changes.
    if (segment.startsWith('init') && existing) {
      const fmp4 = this.activeStreamTracker.getFmp4Supported(mediaFileId);
      const ma =
        this.activeStreamTracker.getAudioStreamCount(mediaFileId) > 1 && fmp4;
      const initFile = ma ? `0/${segment}` : segment;
      const initPath = await this.transcodingService.getSegmentPath(
        existing,
        initFile,
      );
      if (initPath) {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Access-Control-Allow-Origin', '*');
        const initStream = fs.createReadStream(initPath);
        initStream.on('error', () => {
          if (!res.headersSent) res.status(404).end();
        });
        initStream.pipe(res);
        return;
      }
    }

    const segMatch = segment.match(/seg-(\d+)\.(ts|m4s)/);
    const segIndex = segMatch ? parseInt(segMatch[1], 10) : 0;

    // If an active session already has this segment ON DISK, serve it
    // without any DB query or session management. Only checks existsSync
    // (instant) — does NOT call getSegmentPath (which would wait via
    // fs.watch and block the request if the segment isn't being produced).
    if (
      existing &&
      existing.quality === quality &&
      existing.process.exitCode === null
    ) {
      const varStreamMap =
        this.activeStreamTracker.getAudioStreamCount(mediaFileId) > 1 &&
        this.activeStreamTracker.getFmp4Supported(mediaFileId);
      const segName = varStreamMap ? `0/${segment}` : segment;
      const segPath = `${existing.cachePath}/${segName}`;
      if (fs.existsSync(segPath)) {
        existing.lastAccess = Date.now();
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Access-Control-Allow-Origin', '*');
        const stream = fs.createReadStream(segPath);
        stream.on('error', () => {
          if (!res.headersSent) res.status(404).end();
        });
        stream.pipe(res);
        return;
      }
      // Segment not on disk — fall through to full resolve + getOrCreateSession.
    }

    // Slow path: need to create/restart a session — requires DB lookup.
    const resolved = await this.streamingService.resolveFile(
      mediaFileId,
      req.user as User,
    );

    const ctx = this.buildSessionContext(req, resolved, mediaFileId);
    // For remux sessions, copy audio only when the source codec is compatible
    // (captured at playback-info); otherwise transcode audio to AAC.
    const copyAudio = this.activeStreamTracker.getCanCopyAudio(mediaFileId);
    const session =
      quality === 'remux'
        ? await this.transcodingService.getOrCreateRemuxSession(
            mediaFileId,
            resolved.absolutePath,
            copyAudio,
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
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).end();
    });
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
    const resolved = await this.streamingService.resolveFile(
      mediaFileId,
      req.user as User,
    );

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
