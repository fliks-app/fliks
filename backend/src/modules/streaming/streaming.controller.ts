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
import { User } from '../users/entities/user.entity';
import { StreamingService, ResolvedFile } from './streaming.service';
import { SubtitleStreamService } from './subtitle-stream.service';
import {
  TranscodingService,
  PROFILES,
  SessionContext,
  getLadderForDevice,
} from './transcoding';
import { secondsToSegmentIndex } from './transcoding/constants';
import { ThumbnailService } from './thumbnail.service';
import { StreamBuilderService } from './stream-builder.service';
import { ActiveStreamTracker } from './active-stream-tracker.service';
import { SubtitleBurnInService } from './subtitle-burn-in.service';
import { PlaybackService } from './playback.service';
import { MarkersService } from '../markers/markers.service';
import { DeviceProfileDto } from './dto/device-profile.dto';
import { StreamingSettingsCache } from './streaming-settings-cache.service';

const VALID_QUALITIES = new Set([...PROFILES.map((p) => p.name), 'remux']);

/**
 * Inject HLS X-TIMESTAMP-MAP header so the player aligns VTT cues to the
 * absolute MPEGTS timeline of the video stream (which uses -copyts → PTS
 * matches original file time). Without this, players that normalise media
 * time treat VTT time as relative to playback start, which drifts after
 * any seek that doesn't land on an exact keyframe (-noaccurate_seek).
 */
const VTT_TIMESTAMP_MAP = 'X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000';
function withTimestampMap(vtt: string | Buffer): string {
  const text = typeof vtt === 'string' ? vtt : vtt.toString('utf-8');
  return text.replace(/^(WEBVTT[^\n]*)\n/, `$1\n${VTT_TIMESTAMP_MAP}\n`);
}

/** Generate a VOD HLS playlist for a given duration and segment URL pattern. */
/** Default segment + init durations — overridden by admin streaming settings. */
let SEG_DURATION = 3;
let INIT_TIME = 1;

/** Pick the right HLS segment Content-Type. fMP4 (.m4s / .mp4) → video/mp4,
 *  MPEG-TS (.ts, used for Chromecast sessions) → video/MP2T. */
function segmentContentType(segment: string): string {
  return segment.endsWith('.ts') ? 'video/MP2T' : 'video/mp4';
}

function buildVodPlaylist(
  duration: number,
  segmentUrl: (index: string) => string,
  initUrl?: string,
): string {
  // FFmpeg `-hls_init_time` shortens segment 0 to ~INIT_TIME so the first
  // frame ships sooner; remaining segments are SEG_DURATION. The EXTINF
  // values below mirror that layout so Shaka's presentation timeline stays
  // aligned with the moof PTS the segments actually carry.
  const useShortInit = INIT_TIME > 0 && INIT_TIME < SEG_DURATION;
  // Subtract small epsilon before ceil to avoid phantom last segment when
  // ffprobe duration has floating-point imprecision (e.g. 120.001 → ceil
  // produces 41 segments but FFmpeg only writes 40).
  const epsilon = 0.05;
  const tail = Math.max(0, duration - (useShortInit ? INIT_TIME : 0) - epsilon);
  const tailCount = Math.ceil(tail / SEG_DURATION);
  const segCount = Math.max(1, (useShortInit ? 1 : 0) + tailCount);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${Math.ceil(SEG_DURATION)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ];
  if (initUrl) {
    lines.push(`#EXT-X-MAP:URI="${initUrl}"`);
  }
  for (let i = 0; i < segCount; i++) {
    let segStart: number;
    let segLen: number;
    if (useShortInit) {
      if (i === 0) {
        segStart = 0;
        segLen = Math.min(INIT_TIME, duration);
      } else {
        segStart = INIT_TIME + (i - 1) * SEG_DURATION;
        segLen = Math.min(SEG_DURATION, duration - segStart);
      }
    } else {
      segStart = i * SEG_DURATION;
      segLen = Math.min(SEG_DURATION, duration - segStart);
    }
    if (segLen <= 0) break;
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
    private readonly playbackService: PlaybackService,
    private readonly markersService: MarkersService,
    private readonly streamingSettingsCache: StreamingSettingsCache,
  ) {}

  private getStreamingSettings() {
    return this.streamingSettingsCache.get();
  }


  private buildSessionContext(
    req: Request,
    resolved: ResolvedFile,
    mediaFileId: number,
  ): SessionContext {
    const user = req.user;
    const si = resolved.mediaFile.streamInfo;
    // Ensure audio stream count is set from streamInfo if the tracker lost it
    // (e.g. after backend restart, Shaka may replay cached manifest segments
    // without re-fetching master.m3u8).
    const audioCount = si?.audio?.length ?? 0;
    if (audioCount > 0 && this.activeStreamTracker.getAudioStreamCount(mediaFileId) === 0) {
      this.activeStreamTracker.setAudioStreamCount(mediaFileId, audioCount);
    }
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
      // Multi-audio: produce video-only segments and let ffmpeg's var_stream_map
      // emit one audio rendition per track (subdirs 1..N) so Shaka can switch
      // client-side via EXT-X-MEDIA.
      videoOnly:
        this.activeStreamTracker.getAudioStreamCount(mediaFileId) > 1,
      audioStreams:
        this.activeStreamTracker.getAudioStreamCount(mediaFileId) > 1
          ? ((si?.audio as { language?: string; title?: string }[]) ?? [])
          : undefined,
      deviceType: this.activeStreamTracker.getDeviceType(mediaFileId),
      useTs: this.activeStreamTracker.getUseTs(mediaFileId),
      encoderPreset: this.activeStreamTracker.getEncoderPreset(mediaFileId),
      qsvOptions: this.activeStreamTracker.getQsvOptions(),
      // Source framerate (e.g. "24", "23.976", "29.97") — used to compute an
      // accurate GOP so IDR frames fall on the same boundary regardless of
      // source fps. Falls back to 24 when unknown.
      sourceFps: parseFloat(si?.video?.[0]?.frameRate ?? '') || undefined,
      // ffprobe ran at import/rescan and the result is cached in streamInfo —
      // tell FFmpeg to skip its own redundant avformat_find_stream_info scan.
      trustedStreamInfo: !!si?.video?.[0]?.codec,
      // Audio bitstream compatibility (set during playback-info from
      // tryDirectPlay). Threaded through so quality-switch FFmpeg spawns
      // know to keep the source audio instead of forcing AAC stereo.
      copyAudio: this.activeStreamTracker.getCanCopyAudio(mediaFileId),
    };
  }

  /**
   * Pre-spawn ffmpeg for the first segment the player will request. Handles
   * both fresh play (startAt=0) and resume (startAt>0 from URL or from the
   * user's saved playbackState). Fire-and-forget — the session is reused
   * when the player actually requests the segment via getOrCreateSession.
   * Called from playback-info (earliest hook) and from master.m3u8 as a
   * safety net for clients that skip playback-info.
   */
  private async prewarmTranscodeSession(
    mediaFileId: number,
    resolved: ResolvedFile,
    req: Request,
    startQuality: string | undefined,
    startAt: number | undefined,
    deviceType: 'mobile' | 'desktop',
  ): Promise<void> {
    if (!startQuality || startQuality === 'auto') return;
    try {
      // Auto-resume only when the caller did NOT supply a startAt query
      // param (fresh open). An explicit `startAt=0` means the user clicked
      // "restart from beginning" and must override the saved position.
      let effectiveStartAt = startAt;
      if (effectiveStartAt === undefined) {
        const userId = req.user?.id;
        const mediaId = resolved.mediaFile.mediaId;
        if (userId && mediaId) {
          const state = await this.playbackService.getState(
            userId,
            mediaId,
            resolved.mediaFile.episodeId ?? undefined,
          );
          if (state && !state.completed && state.positionSeconds > 10) {
            effectiveStartAt = state.positionSeconds;
          }
        }
        effectiveStartAt = effectiveStartAt ?? 0;
      }
      const existing = this.transcodingService.getExistingSession(
        mediaFileId,
        req.user?.id,
      );
      if (existing && existing.process.exitCode === null) return;
      const ctx = this.buildSessionContext(req, resolved, mediaFileId);
      // 'remux'/'original' are mapped to the top transcode profile in the
      // master playlist — do the same mapping here so the pre-spawned
      // session matches the variant the player is about to request.
      let targetQuality = startQuality;
      if (startQuality === 'remux' || startQuality === 'original') {
        const sourceW =
          this.activeStreamTracker.getSourceWidth(mediaFileId) || 0;
        const ladder = getLadderForDevice(deviceType);
        const top = ladder.find((p) => p.maxWidth <= sourceW) ?? ladder[0];
        targetQuality = top.name;
      }
      const startSegment = Math.max(0, secondsToSegmentIndex(effectiveStartAt));

      // Spawn early en PARALLÈLE de main (fire-and-forget). hlsSegment
      // routera vers cette session pour seg-0 via isEarlyProbe pendant
      // que main encode forward depuis seg-K.
      if (startSegment > 0) {
        void this.transcodingService
          .getOrCreateEarlySession(
            mediaFileId,
            targetQuality,
            resolved.absolutePath,
            ctx,
          )
          .catch((err) => this.log.warn(`[early] spawn failed: ${err}`));
      }

      // skipVerify: don't poll for first segment here. We only need the
      // session in the sessions map so a racing hlsSegment doesn't spawn
      // its own concurrent main at start_number=0.
      await this.transcodingService.getOrCreateSession(
        mediaFileId,
        targetQuality,
        resolved.absolutePath,
        startSegment,
        ctx,
        /* skipVerify */ true,
      );
    } catch {
      /* prewarm is best-effort */
    }
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

  /** Available download qualities for a media file (used by download-quality modal). */
  @Get('info/qualities/:mediaFileId')
  async downloadQualities(
    @Req() req: Request,
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
  ) {
    const resolved = await this.streamingService.resolveFile(mediaFileId, req.user as User);
    const info = resolved.mediaFile.streamInfo;
    const fileSize = resolved.size;
    const video = (info as any)?.video?.[0];
    const sourceWidth = video?.width ?? 1920;
    const sourceHeight = video?.height ?? 1080;
    const sourceBitrate = (info as any)?.formatBitRate ?? 0;

    const qualities: { key: string; label: string; estimatedSize: number }[] = [];
    for (const p of PROFILES) {
      if (p.maxWidth > sourceWidth && p.maxHeight > sourceHeight) continue;
      const videoBps = this.parseBitrateString(p.videoBitrate);
      const audioBps = this.parseBitrateString(p.audioBitrate);
      const duration = (info as any)?.durationSeconds ?? 0;
      const estimated =
        duration > 0
          ? Math.floor(((videoBps + audioBps) * duration) / 8)
          : Math.floor(fileSize * (videoBps / Math.max(sourceBitrate, videoBps)));
      const sizeLabel =
        estimated >= 1e9
          ? `${(estimated / 1e9).toFixed(1)} GB`
          : estimated >= 1e6
            ? `${(estimated / 1e6).toFixed(0)} MB`
            : `${(estimated / 1e3).toFixed(0)} KB`;
      qualities.push({
        key: p.name,
        label: `${p.name} (~${sizeLabel})`,
        estimatedSize: estimated,
      });
    }
    return qualities;
  }

  private parseBitrateString(s: string): number {
    const match = s.match(/^(\d+(?:\.\d+)?)\s*(k|m)?$/i);
    if (!match) return 0;
    const n = parseFloat(match[1]);
    const unit = (match[2] ?? '').toLowerCase();
    if (unit === 'k') return n * 1000;
    if (unit === 'm') return n * 1_000_000;
    return n;
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

    const ss = await this.getStreamingSettings();

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
    this.activeStreamTracker.setDeviceType(
      mediaFileId,
      deviceProfile.deviceType ?? 'desktop',
    );
    this.activeStreamTracker.setUseTs(
      mediaFileId,
      !!deviceProfile.useTs,
    );
    this.activeStreamTracker.setStreamingDurations(
      ss.segmentDuration,
      ss.initTime,
    );
    // Update module-level constants used by buildVodPlaylist and transcoding
    SEG_DURATION = ss.segmentDuration;
    INIT_TIME = ss.initTime;
    this.transcodingService.setSegmentDurations(
      ss.segmentDuration,
      ss.initTime,
    );

    // Persist encoder preset + QSV advanced options for downstream sessions.
    this.activeStreamTracker.setEncoderPreset(mediaFileId, ss.qsvPreset);
    this.activeStreamTracker.setQsvOptions({
      lowPower: ss.qsvLowPower,
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

    // Pre-spawn ffmpeg as early as possible — the client will GET master.m3u8
    // next (~100–300ms later) and then seg-0. Starting ffmpeg here overlaps
    // that gap with encoder init so segment 0 is usually already on disk
    // (or streaming) when requested. No-op for DirectPlay or auto quality.
    if (result.playMethod !== 'DirectPlay') {
      const startQuality = firstQueryString(req.query, 'startQuality');
      const startAtRaw = firstQueryString(req.query, 'startAt');
      const startAt =
        startAtRaw != null ? parseFloat(startAtRaw) : undefined;
      // Await prewarm before responding so the session is registered in the
      // map when the frontend's subsequent master.m3u8/seg-0 requests
      // arrive — prevents a race where hlsSegment would spawn a duplicate
      // main at start_number=0 and force a kill+restart.
      await this.prewarmTranscodeSession(
        mediaFileId,
        resolved,
        req,
        startQuality,
        startAt,
        deviceProfile.deviceType ?? 'desktop',
      );
    }

    // Mark a new watch-history entry (history = sessions started).
    // Fire-and-forget — a DB hiccup should not block stream start.
    const user = req.user as User;
    if (user?.id && resolved.mediaFile.mediaId) {
      this.playbackService
        .markSessionStarted(
          user.id,
          resolved.mediaFile.mediaId,
          mediaFileId,
          resolved.mediaFile.episodeId ?? null,
        )
        .catch((err) =>
          this.log.warn(`Failed to mark session started: ${err}`),
        );
    }

    // Include duration so the player can skip ffprobe in hlsPlaylist
    const duration = resolved.mediaFile.streamInfo?.durationSeconds ?? 0;

    // Episode-level markers for the player (skip-intro / next-episode UI).
    const episodeId = resolved.mediaFile.episodeId;
    let intro: { startSeconds: number; endSeconds: number } | undefined;
    let outro: { startSeconds: number; endSeconds: number } | undefined;
    if (episodeId) {
      const [introMarker, outroMarker] = await Promise.all([
        this.markersService.findIntroForEpisode(episodeId),
        this.markersService.findOutroForEpisode(episodeId),
      ]);
      if (introMarker) {
        intro = {
          startSeconds: introMarker.startSeconds,
          endSeconds: introMarker.endSeconds,
        };
      }
      if (outroMarker) {
        outro = {
          startSeconds: outroMarker.startSeconds,
          endSeconds: outroMarker.endSeconds,
        };
      }
      if (intro || outro) {
        this.log.log(
          `playback-info: episode #${episodeId} markers intro=${intro ? `${intro.startSeconds.toFixed(0)}–${intro.endSeconds.toFixed(0)}` : '∅'} outro=${outro ? `${outro.startSeconds.toFixed(0)}–${outro.endSeconds.toFixed(0)}` : '∅'}`,
        );
      }
    }
    const markers = intro || outro ? { intro, outro } : undefined;

    // Embedded chapter markers (MKV/MP4). Always forwarded when present so
    // the player can render them on the seekbar.
    const chapters = resolved.mediaFile.streamInfo?.chapters?.length
      ? resolved.mediaFile.streamInfo.chapters
      : undefined;

    return {
      ...result,
      durationSeconds: duration,
      markers,
      chapters,
    };
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
    // Multi-audio is exposed via separate EXT-X-MEDIA renditions so the
    // player can switch audio client-side without a reload. Every rendition
    // is listed even when the user has picked a specific track — the picked
    // track is marked DEFAULT=YES so the player preselects it.
    const pickedIdx = this.activeStreamTracker.getAudioStreamIndex(mediaFileId);
    const useExtXMedia = audioStreams.length > 1;
    const onlyQuality = firstQueryString(req.query, 'startQuality');
    // Device type: URL param wins (stream URL is built by the frontend with
    // the cached client profile); fall back to whatever playback-info stored.
    const deviceParam = firstQueryString(req.query, 'device');
    const deviceType: 'mobile' | 'desktop' =
      deviceParam === 'mobile' || deviceParam === 'desktop'
        ? deviceParam
        : this.activeStreamTracker.getDeviceType(mediaFileId);
    this.activeStreamTracker.setDeviceType(mediaFileId, deviceType);

    const playlist = this.transcodingService.generateMasterPlaylist(
      mediaFileId,
      w,
      h,
      tokenParam,
      includeRemux,
      sourceBitrate || undefined,
      useExtXMedia ? audioStreams : undefined,
      onlyQuality,
      pickedIdx ?? 0,
      deviceType,
      this.activeStreamTracker.getCanCopyAudio(mediaFileId),
    );

    this.activeStreamTracker.setAudioStreamCount(
      mediaFileId,
      audioStreams.length,
    );
    this.activeStreamTracker.setUseExtXMedia(
      mediaFileId,
      useExtXMedia,
    );

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.send(playlist);

    // Pre-spawn ffmpeg when we know the player will start at seg-0 (fresh
    // play, not resume). Usually a no-op when playback-info already
    // pre-warmed the session; acts as a safety net otherwise.
    const startAtRaw = firstQueryString(req.query, 'startAt');
    const startAt =
      startAtRaw != null ? parseFloat(startAtRaw) : undefined;
    void this.prewarmTranscodeSession(
      mediaFileId,
      resolved,
      req,
      onlyQuality,
      startAt,
      deviceType,
    );
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
    res.send(withTimestampMap(vtt));
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
    res.send(withTimestampMap(vtt));
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
    const useTs = this.activeStreamTracker.getUseTs(mediaFileId);
    const segExt = useTs ? 'ts' : 'm4s';
    const playlist = buildVodPlaylist(
      duration,
      (seg) => `${basePath}/seg-${seg}.${segExt}${tokenParam}`,
      useTs
        ? undefined
        : `${basePath}/init_${audioIndex + 1}.mp4${tokenParam}`,
    );

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
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
    const AUDIO_SEG_RE = /^(init(_\d+)?\.mp4|seg-\d{3,4}\.(m4s|ts))$/;
    if (!AUDIO_SEG_RE.test(segment)) {
      throw new BadRequestException(`Invalid audio segment name: ${segment}`);
    }

    const segMatch = segment.match(/seg-(\d+)\.(m4s|ts)/);
    const segIndex = segMatch ? parseInt(segMatch[1], 10) : 0;
    const isInit = segment.startsWith('init');
    const user = req.user;
    // var_stream_map writes audio under `<variantIdx>/`; variant 0 is video,
    // each audio rendition lives under `<audioIndex+1>/` and its init is
    // named `init_<audioIndex+1>.mp4` to match `-hls_fmp4_init_filename`.
    const varStreamPath = `${audioIndex + 1}/${segment}`;

    // Spawn the video session if Shaka raced ahead of playback-info / master.m3u8
    // and there is none registered yet. The audio rendition playlist always rides
    // on a multi-audio video session (master.m3u8 only emits EXT-X-MEDIA when
    // `audioStreams.length > 1`), so we don't need a separate audio-only path —
    // any segment Shaka asks for here is in `<videoSession.cachePath>/<varStreamPath>`.
    let videoSession = this.transcodingService.getExistingSession(
      mediaFileId,
      user?.id,
    );
    if (!videoSession) {
      const resolved = await this.streamingService.resolveFile(
        mediaFileId,
        req.user as User,
      );
      const ctx = this.buildSessionContext(req, resolved, mediaFileId);
      const deviceType =
        this.activeStreamTracker.getDeviceType(mediaFileId) ?? 'desktop';
      const sourceW =
        this.activeStreamTracker.getSourceWidth(mediaFileId) || 1920;
      const sourceH =
        this.activeStreamTracker.getSourceHeight(mediaFileId) || 1080;
      const profiles = this.transcodingService.getAvailableProfiles(
        sourceW,
        sourceH,
        deviceType,
      );
      const quality = (profiles[0] ?? PROFILES[PROFILES.length - 1]).name;
      videoSession = await this.transcodingService.getOrCreateSession(
        mediaFileId,
        quality,
        resolved.absolutePath,
        0,
        ctx,
        /* skipVerify */ true,
      );
    }

    // Resume: the early companion produces variant inits + seg-0/seg-1 in
    // parallel with main, so it lands first. Use a short timeout — main
    // covers the same files behind it, so wasting 60s on early when it has
    // already exited adds latency for nothing.
    const earlySession = this.transcodingService.getExistingEarlySession(
      mediaFileId,
      user?.id,
    );
    const useEarly =
      earlySession != null &&
      videoSession.startSegment != null &&
      videoSession.startSegment > 0 &&
      earlySession.quality === videoSession.quality &&
      (isInit || segIndex < videoSession.startSegment);

    let segPath: string | null = null;
    if (useEarly && earlySession) {
      segPath = await this.transcodingService.getSegmentPath(
        earlySession,
        varStreamPath,
        10_000,
      );
    }

    // Fall through to main when:
    //   - no early companion (fresh play, startSegment === 0), or
    //   - early didn't produce in time (already exited / cleaned up), or
    //   - segIndex >= startSegment (only main ever writes those).
    if (!segPath) {
      segPath = await this.transcodingService.getSegmentPath(
        videoSession,
        varStreamPath,
      );
    }

    if (!segPath) {
      res.status(404).send('Segment not found');
      return;
    }

    res.setHeader('Content-Type', segmentContentType(segment));
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
        const startSegment = secondsToSegmentIndex(startAtSec);
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
    // Use the master.m3u8 decision — must match to avoid init filename mismatch.
    const multiAudio = this.activeStreamTracker.getUseExtXMedia(mediaFileId);
    const useTs = this.activeStreamTracker.getUseTs(mediaFileId);
    // Cast sessions use MPEG-TS segments (no init segment) to avoid the
    // fMP4 priming desync the Cast receiver doesn't compensate for.
    const segExt = useTs ? 'ts' : 'm4s';
    const initName = useTs
      ? undefined
      : multiAudio
        ? 'init_0.mp4'
        : 'init.mp4';
    const playlist = buildVodPlaylist(
      duration,
      (seg) => `${basePath}/seg-${seg}.${segExt}${tokenParam}`,
      initName ? `${basePath}/${initName}${tokenParam}` : undefined,
    );

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.send(playlist);
  }

  /** HLS segment — serves a transcoded .m4s segment or fMP4 init. */
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
    const VIDEO_SEG_RE = /^(seg-\d{3,4}\.(m4s|ts)|init(_\d+)?\.mp4)$/;
    if (!VIDEO_SEG_RE.test(segment)) {
      throw new BadRequestException(`Invalid segment name: ${segment}`);
    }
    if (
      segment.startsWith('init') ||
      segment === 'seg-0000.m4s' ||
      segment === 'seg-0000.ts'
    ) {
      this.log.log(
        `[request] ${segment} mfid=${mediaFileId} quality=${quality}`,
      );
    }

    // Fast path: if a session already exists, skip the DB query — we only
    // need resolveFile for absolutePath + context when creating a NEW session.
    // Saves ~15-25ms per segment (a 2h file = ~2400 segments = ~40s saved).
    const existing = this.transcodingService.getExistingSession(
      mediaFileId,
      req.user?.id,
    );

    // For init.mp4: serve from the early session when it exists with matching
    // quality. Its init bytes are byte-identical to main's (same encoder
    // profile, dimensions, codec config) and ready ~1.5s sooner because it
    // has no `-ss` seek and is bounded by `-t 4`. Without this, init.mp4
    // would block on the main session's HDR-tonemap+seek cold-start
    // (~3s on 4K HDR), gating Shaka's first-frame render on the slowest
    // path even though seg-0 was already served from early.
    if (segment.startsWith('init') && existing) {
      const ma = this.activeStreamTracker.getUseExtXMedia(mediaFileId);
      const initFile = ma ? `0/${segment}` : segment;
      const earlySession = this.transcodingService.getExistingEarlySession(
        mediaFileId,
        req.user?.id,
      );
      const sources =
        earlySession && earlySession.quality === existing.quality
          ? [
              { session: earlySession, label: 'early' as const },
              { session: existing, label: 'main-fallback' as const },
            ]
          : [{ session: existing, label: 'main' as const }];
      for (const { session: src, label } of sources) {
        const initPath = await this.transcodingService.getSegmentPath(
          src,
          initFile,
        );
        if (initPath) {
          res.setHeader('Content-Type', segmentContentType(segment));
          res.setHeader('Access-Control-Allow-Origin', '*');
          const initStream = fs.createReadStream(initPath);
          initStream.on('error', () => {
            if (!res.headersSent) res.status(404).end();
          });
          initStream.pipe(res);
          return;
        }
      }
    }

    const segMatch = segment.match(/seg-(\d+)\.(ts|m4s)/);
    const segIndex = segMatch ? parseInt(segMatch[1], 10) : 0;

    // If a session (running OR completed) already has this segment ON DISK,
    // serve it without any DB query or session management. Completed sessions
    // (exitCode !== null) still have valid segments in cache — don't skip them.
    if (existing && existing.quality === quality) {
      const varStreamMap = this.activeStreamTracker.getUseExtXMedia(mediaFileId);
      const segName = varStreamMap ? `0/${segment}` : segment;
      const segPath = `${existing.cachePath}/${segName}`;
      if (fs.existsSync(segPath)) {
        existing.lastAccess = Date.now();
        res.setHeader('Content-Type', segmentContentType(segment));
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

    // Early probe routing: when Shaka requests a segment before the main
    // session's startSegment (typical Shaka VOD behavior on resume), route
    // to the early companion if it exists. 10s timeout safety net : si
    // early hang (régression du fix Phase 2), fall through au slow path
    // standard rather than blocking 60s.
    const isEarlyProbe =
      quality !== 'remux' &&
      existing != null &&
      existing.quality === quality &&
      existing.startSegment != null &&
      existing.startSegment > 0 &&
      segIndex < existing.startSegment;
    if (isEarlyProbe) {
      const earlySession = this.transcodingService.getExistingEarlySession(
        mediaFileId,
        req.user?.id,
      );
      if (earlySession && earlySession.quality === quality) {
        const varStreamMap =
          this.activeStreamTracker.getUseExtXMedia(mediaFileId);
        const segName = varStreamMap ? `0/${segment}` : segment;
        const segPath = await this.transcodingService.getSegmentPath(
          earlySession,
          segName,
          10_000,
        );
        if (segPath) {
          res.setHeader('Content-Type', segmentContentType(segment));
          res.setHeader('Access-Control-Allow-Origin', '*');
          const stream = fs.createReadStream(segPath);
          stream.on('error', () => {
            if (!res.headersSent) res.status(404).end();
          });
          stream.pipe(res);
          return;
        }
        // Early failed/timeout — log and fall through to slow path
        this.log.error(
          `[early] no seg-${segIndex} after 10s for mfid=${mediaFileId} — fallback`,
        );
      }
    }

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
    const varStreamMap = this.activeStreamTracker.getUseExtXMedia(mediaFileId);
    const segName = varStreamMap ? `0/${segment}` : segment;

    const segPath = await this.transcodingService.getSegmentPath(
      session,
      segName,
    );
    if (!segPath) {
      this.log.warn(
        `Segment 404: ${segment} (quality=${quality}, mfid=${mediaFileId}, exitCode=${session.process.exitCode})`,
      );
      res.status(404).send('Segment not found');
      return;
    }

    res.setHeader('Content-Type', segmentContentType(segment));
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
