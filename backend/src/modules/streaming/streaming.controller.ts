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
  DESKTOP_HDR_PROFILES,
  SessionContext,
  getHdrLadderForDevice,
  getLadderForDevice,
  profileFitsSource,
} from './transcoding';
import { secondsToSegmentIndex } from './transcoding/constants';
import { readAndRewriteCmaf } from './transcoding/cmaf-rewrite';
import { resolveTonemapPath } from './transcoding/tonemap-path';
import { ThumbnailService } from './thumbnail.service';
import { StreamBuilderService } from './stream-builder.service';
import { ActiveStreamTracker } from './active-stream-tracker.service';
import { SubtitleBurnInService } from './subtitle-burn-in.service';
import { PlaybackService } from './playback.service';
import { MarkersService } from '../markers/markers.service';
import { DeviceProfileDto } from './dto/device-profile.dto';
import { StreamingSettingsCache } from './streaming-settings-cache.service';

const VALID_QUALITIES = new Set([
  ...PROFILES.map((p) => p.name),
  ...DESKTOP_HDR_PROFILES.map((p) => p.name),
  'remux',
]);

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

/** Default segment duration — overridden by admin streaming settings. */
let SEG_DURATION = 3;

/** Pick the right HLS segment Content-Type. fMP4 (.m4s / .mp4) → video/mp4,
 *  MPEG-TS (.ts, used as the explicit `useTs` fallback for Tizen TVs on
 *  older firmwares — issue #148) → video/MP2T. */
function segmentContentType(segment: string): string {
  return segment.endsWith('.ts') ? 'video/MP2T' : 'video/mp4';
}

/** Decide whether ffmpeg should emit muxed segments (`inline`) or the
 *  EXT-X-MEDIA layout (`var-stream-map`, video-only main + audio served
 *  as separate renditions).
 *
 *  Rules (single source of truth, mirrored by `master-playlist.ts` and
 *  `ffmpeg-args.ts`):
 *    1. Zero audio sources → inline (degenerate, no audio rendition).
 *    2. Multi-audio sources → var-stream-map (Shaka / AVPlay pick the
 *       rendition client-side without a backend reload).
 *    3. Single-audio sources → inline regardless of mux flavour. The
 *       HLS muxer's hardcoded `+frag_custom+dash+delay_moov` movflags
 *       used to produce iso5+sidx fMP4 segments AVPlay rejected (issue
 *       #148), which forced the var_stream_map workaround. With the
 *       in-tree `cmaf-rewrite` post-processor stripping `sidx` /
 *       `styp` and stamping the `hlsf` brand on every served chunk,
 *       muxed segments parse on AVPlay too — and the single-variant
 *       master that comes with single-audio doesn't trigger AVPlay's
 *       audio-rendition probe, so leaving audio inline is the only
 *       layout that actually plays on Tizen single-audio fmp4. */
export function pickAudioLayout(
  audioCount: number,
  _muxFlavour: 'ts' | 'fmp4',
): 'inline' | 'var-stream-map' {
  if (audioCount <= 1) return 'inline';
  return 'var-stream-map';
}

/**
 * Poll `filePath` until its size is non-zero or the timeout elapses.
 * Returns `true` when the file became non-empty, `false` on timeout
 * or missing path. Used to absorb the ~200-500 ms gap between
 * ffmpeg's `creat()` (visible to the kernel) and its first
 * moov-box write (visible to the player). Anything looking at the
 * file in that window sees a 0-byte entry and would, without this
 * helper, serve a corrupt 200 or a transient 404.
 */
async function awaitFileNonEmpty(
  filePath: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 0) return true;
    } catch {
      /* still creating */
    }
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  return false;
}

/** Send a transient unavailability response. Players with sane HTTP
 *  retry policies (Shaka, Media3's loader when given a backoff)
 *  treat 503 as retryable, unlike 404 which Media3 marks as a
 *  terminal failure. `Retry-After` is honoured by both stacks. */
function sendTransientUnavailable(res: Response, retryAfterSec: number = 2): void {
  res.setHeader('Retry-After', String(retryAfterSec));
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.status(503).end();
}

/** Generate a VOD HLS playlist for a given duration and segment URL pattern.
 *  Uniform segment grid: each segment is SEG_DURATION seconds, seg-N covers
 *  `[N*SEG, (N+1)*SEG)`. The EXTINF values mirror what FFmpeg actually emits
 *  so Shaka's presentation timeline stays aligned with the moof PTS the
 *  segments carry. */
function buildVodPlaylist(
  duration: number,
  segmentUrl: (index: string) => string,
  initUrl?: string,
): string {
  // Subtract small epsilon before ceil to avoid phantom last segment when
  // ffprobe duration has floating-point imprecision (e.g. 120.001 → ceil
  // produces 41 segments but FFmpeg only writes 40).
  const epsilon = 0.05;
  const segCount = Math.max(
    1,
    Math.ceil(Math.max(0, duration - epsilon) / SEG_DURATION),
  );
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
    const segStart = i * SEG_DURATION;
    const segLen = Math.min(SEG_DURATION, duration - segStart);
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
    if (
      audioCount > 0 &&
      this.activeStreamTracker.getAudioStreamCount(mediaFileId) === 0
    ) {
      this.activeStreamTracker.setAudioStreamCount(mediaFileId, audioCount);
    }
    const trackedAudioCount =
      this.activeStreamTracker.getAudioStreamCount(mediaFileId);
    const muxFlavour: 'ts' | 'fmp4' = this.activeStreamTracker.getUseTs(
      mediaFileId,
    )
      ? 'ts'
      : 'fmp4';
    const useMultiAudioLayout =
      pickAudioLayout(trackedAudioCount, muxFlavour) === 'var-stream-map';
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
      videoOnly: useMultiAudioLayout,
      // Always plumb the cached audio streams (incl. `streamIndex`) so the
      // single-track path can also resolve `-map 0:<abs>` and skip FFmpeg's
      // audio enumeration. `useMultiAudioLayout` only gates the var_stream_map
      // branch, not the presence of the data.
      audioStreams: si?.audio ?? undefined,
      deviceType: this.activeStreamTracker.getDeviceType(mediaFileId),
      useTs: this.activeStreamTracker.getUseTs(mediaFileId),
      encoderPreset: this.activeStreamTracker.getEncoderPreset(mediaFileId),
      qsvOptions: this.activeStreamTracker.getQsvOptions(),
      tonemapAlgo: this.activeStreamTracker.getTonemapAlgo(),
      // Source framerate (e.g. "24", "23.976", "29.97") — used to compute an
      // accurate GOP so IDR frames fall on the same boundary regardless of
      // source fps. Falls back to 24 when unknown.
      sourceFps: parseFloat(si?.video?.[0]?.frameRate ?? '') || undefined,
      // ffprobe ran at import/rescan and the result is cached in streamInfo —
      // tell FFmpeg to skip its own redundant avformat_find_stream_info scan.
      trustedStreamInfo: !!si?.video?.[0]?.codec,
      // Canonical audio decision — computed once in stream-builder, lives
      // in the tracker, threaded through here so respawns / quality
      // switches stay coherent with what playback-info promised.
      audioPlan:
        this.activeStreamTracker.getAudioPlan(mediaFileId) ?? undefined,
      sourceVideoCodec:
        (si?.video?.[0]?.codec ?? '').toLowerCase() || undefined,
      sourceWidth: si?.video?.[0]?.width,
      sourceHeight: si?.video?.[0]?.height,
      isSourceHdr: !!si?.video?.[0]?.hdrFormat,
      // Variant chosen by stream-builder's codec selector at
      // playback-info time, threaded through every session spawn so
      // ffmpeg-args resolves the matching encoder descriptor.
      // ActiveStreamTracker holds it after a successful playback-info;
      // a segment request that arrives before playback-info has populated
      // the tracker hits `buildFfmpegArgs`'s explicit throw, which surfaces
      // as a 5xx the player retries after the next playback-info call.
      videoVariant: this.activeStreamTracker.getVideoVariant(mediaFileId),
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

      // `remux` / `original` resolve to the player's actual rung only
      // after the manifest loads — Shaka filters variants whose
      // CODECS string the browser can't decode (HEVC Main10 L5.1 is
      // commonly filtered on web), so the top rung we'd guess from
      // the device ladder is often not what the player ends up
      // requesting. Skipping the prewarm for these pseudo-labels
      // avoids the spawn-then-kill dance; the player's first segment
      // fetch starts ffmpeg synchronously at the correct rung.
      if (startQuality === 'remux' || startQuality === 'original') return;
      // When the HDR ladder is in effect, the master only publishes
      // `*-hdr` rungs. The frontend's saved quality is height-based
      // (`1080p`), so translate to the HDR equivalent so prewarm
      // doesn't spawn a doomed SDR session that the player will
      // immediately kill and replace with the matching HDR rung.
      const targetQuality =
        this.activeStreamTracker.getHdrLadder(mediaFileId) &&
        !startQuality.endsWith('-hdr')
          ? `${startQuality}-hdr`
          : startQuality;
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

  /** Serve an fMP4 init or segment, rewriting the bytes for AVPlay
   *  compatibility (Tizen) before flushing them to the client.
   *
   *  The rewrite happens in memory and the result is sent via `res.end`
   *  rather than `createReadStream`: ffmpeg's HLS muxer rewrites init
   *  and segments in-place on session restart, and that overwrite races
   *  the `stat` → `createReadStream` window — the response ends up with
   *  a Content-Length from one revision of the file and bytes from
   *  another. Serving from the rewritten buffer takes that race off the
   *  table. */
  private async serveCmafFile(
    res: Response,
    filePath: string,
    contentType: string,
  ): Promise<void> {
    const buf = await readAndRewriteCmaf(filePath);
    if (!buf || buf.length === 0) {
      if (!res.headersSent) res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Cloudflare (and any intermediate CDN) will gladly cache a 0-byte
    // 200 response under the URL and serve it back for 4h by default —
    // turning a transient cold-start race into a session-killing
    // permanent failure. Mark each fMP4 chunk un-cacheable so a CDN
    // refusing the upstream length check never pins a broken response.
    res.setHeader('Cache-Control', 'no-store');
    res.end(buf);
  }

  /** Available download qualities for a media file (used by download-quality modal). */
  @Get('info/qualities/:mediaFileId')
  async downloadQualities(
    @Req() req: Request,
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
  ) {
    const resolved = await this.streamingService.resolveFile(
      mediaFileId,
      req.user as User,
    );
    const info = resolved.mediaFile.streamInfo;
    const fileSize = resolved.size;
    const video = (info as any)?.video?.[0];
    const sourceWidth = video?.width ?? 1920;
    const sourceHeight = video?.height ?? 1080;
    const sourceBitrate = (info as any)?.formatBitRate ?? 0;

    const qualities: { key: string; label: string; estimatedSize: number }[] =
      [];
    for (const p of PROFILES) {
      if (!profileFitsSource(p, sourceWidth, sourceHeight)) continue;
      const videoBps = this.parseBitrateString(p.videoBitrate);
      const audioBps = this.parseBitrateString(p.audioBitrate);
      const duration = (info as any)?.durationSeconds ?? 0;
      const estimated =
        duration > 0
          ? Math.floor(((videoBps + audioBps) * duration) / 8)
          : Math.floor(
              fileSize * (videoBps / Math.max(sourceBitrate, videoBps)),
            );
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

  /** HDR→SDR tone-mapping algorithms available on this host. Drives the
   *  admin streaming-settings dropdown so platforms that can't run a
   *  given path (macOS for VAAPI/QSV/OpenCL, Linux without the OpenCL
   *  stack, Intel-less hosts for QSV, …) don't surface options that
   *  would fail at session time. `'auto'` is always present. */
  @Get('info/tonemap-algos')
  tonemapAlgosInfo() {
    return {
      available: this.transcodingService.getAvailableTonemapAlgos(),
    };
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
    // Resolve the effective `useTs`. The explicit profile flag wins as
    // an admin / debug hard override. Otherwise Tizen-style profiles
    // opt into TS only when the source has zero or one audio track
    // (single-audio fmp4 hits AVPlay's missing-rendition-probe stall;
    // see DTO docstring and issue #148).
    const sourceAudioCount = resolved.mediaFile.streamInfo?.audio?.length ?? 0;
    const effectiveUseTs =
      !!deviceProfile.useTs ||
      (!!deviceProfile.useTsOnSingleAudio && sourceAudioCount <= 1);
    this.activeStreamTracker.setUseTs(mediaFileId, effectiveUseTs);
    this.activeStreamTracker.setStreamingDuration(ss.segmentDuration);
    // Update module-level constants used by buildVodPlaylist and transcoding
    SEG_DURATION = ss.segmentDuration;
    this.transcodingService.setSegmentDuration(ss.segmentDuration);

    // Persist encoder preset + QSV advanced options for downstream sessions.
    this.activeStreamTracker.setEncoderPreset(mediaFileId, ss.qsvPreset);
    this.activeStreamTracker.setQsvOptions({
      lowPower: ss.qsvLowPower,
    });
    this.activeStreamTracker.setTonemapAlgo(ss.tonemapAlgo);

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
    // Canonical audio decision computed by stream-builder. Drives the
    // ffmpeg-args codec branch, master-playlist CODECS string and admin
    // dashboard rendering — single source of truth.
    this.activeStreamTracker.setAudioPlan(mediaFileId, result.audioPlan);
    const sv = resolved.mediaFile.streamInfo?.video?.[0];
    this.activeStreamTracker.setSourceDimensions(
      mediaFileId,
      sv?.width ?? 0,
      sv?.height ?? 0,
    );

    // Device-profile drift detection. A single user can hop between a
    // browser tab (which accepts EAC-3 copy on 2-ch) and the Chromecast
    // (AAC transcode only) without unloading the file. The session map
    // is keyed (mediaFileId, userId), so both hops share the same
    // entry — and prewarm short-circuits on `existing.exitCode === null`
    // without comparing plans. The result is a manifest advertising the
    // new codec while ffmpeg keeps writing segments in the old one,
    // tripping Shaka 4032 (CONTENT_UNSUPPORTED_BY_BROWSER) on Cast.
    // Kill the running session whenever the new audio plan, the new
    // video variant or the new mux flavour (Tizen hopping TS ↔ fmp4)
    // disagrees with what it was spawned for; the prewarm immediately
    // below then respawns with the up-to-date plan.
    const newAudioCodec = result.audioPlan?.codec;
    const newVideoCodec = this.activeStreamTracker
      .getVideoVariant(mediaFileId)
      ?.codec;
    const newMuxFlavour: 'ts' | 'fmp4' = effectiveUseTs ? 'ts' : 'fmp4';
    // Audio layout the *next* session would be spawned with. Mirrors
    // the gate in `buildSessionContext` so flipping `useTs` (which
    // toggles muxed-vs-separated audio under us) kills the running
    // session instead of leaving an EXT-X-MEDIA master pointing at a
    // `var_stream_map`-less segment tree.
    const trackedAudioCount =
      this.activeStreamTracker.getAudioStreamCount(mediaFileId);
    const newAudioLayout: 'inline' | 'var-stream-map' = pickAudioLayout(
      trackedAudioCount,
      newMuxFlavour,
    );
    const existingForDrift = this.transcodingService.getExistingSession(
      mediaFileId,
      req.user?.id,
    );
    if (
      existingForDrift &&
      existingForDrift.process.exitCode === null &&
      (existingForDrift.audioPlan?.codec !== newAudioCodec ||
        existingForDrift.videoVariant?.codec !== newVideoCodec ||
        (existingForDrift.muxFlavour &&
          existingForDrift.muxFlavour !== newMuxFlavour) ||
        (existingForDrift.audioLayout &&
          existingForDrift.audioLayout !== newAudioLayout))
    ) {
      this.log.log(
        `[playback-info] profile drift on file ${mediaFileId} — killing session ` +
          `(audio: ${existingForDrift.audioPlan?.codec ?? '∅'} → ${newAudioCodec ?? '∅'}, ` +
          `video: ${existingForDrift.videoVariant?.codec ?? '∅'} → ${newVideoCodec ?? '∅'}, ` +
          `mux: ${existingForDrift.muxFlavour ?? '∅'} → ${newMuxFlavour}, ` +
          `audioLayout: ${existingForDrift.audioLayout ?? '∅'} → ${newAudioLayout})`,
      );
      await this.transcodingService.killSession(mediaFileId, req.user?.id);
    }

    // Pre-spawn ffmpeg as early as possible — the client will GET master.m3u8
    // next (~100–300ms later) and then seg-0. Starting ffmpeg here overlaps
    // that gap with encoder init so segment 0 is usually already on disk
    // (or streaming) when requested. No-op for DirectPlay or auto quality.
    if (result.playMethod !== 'DirectPlay') {
      const startQuality = firstQueryString(req.query, 'startQuality');
      const startAtRaw = firstQueryString(req.query, 'startAt');
      const startAt = startAtRaw != null ? parseFloat(startAtRaw) : undefined;
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

    // Surface the actually-used tonemap filter (after `auto` resolution
    // + boot probe). Stats overlay reads this so it can show what's
    // running, not what was originally requested.
    const hasCrop =
      resolved.mediaFile.streamInfo?.video?.[0]?.crop != null;
    const tonemapAlgo = result.tonemapping
      ? resolveTonemapPath(ss.tonemapAlgo, { hasCrop })
      : null;

    return {
      ...result,
      tonemapAlgo,
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
    // HDR ladder eligibility — decided by stream-builder at playback-info
    // time and cached in the tracker. Independent from `includeRemux`:
    // even a /master.m3u8 without `?remux=1` should emit the HDR ladder
    // when the source + client combination warrant it.
    const sourceHdrFormat = v?.hdrFormat as 'HDR10' | 'HLG' | undefined;
    const hdrPassThrough =
      this.activeStreamTracker.getHdrLadder(mediaFileId) && sourceHdrFormat
        ? {
            hdrFormat: sourceHdrFormat,
            videoBitRateBps: v?.bitRate ?? undefined,
            audioBitRateBps: si?.audio?.[0]?.bitRate ?? undefined,
          }
        : undefined;
    const audioStreams = si?.audio ?? [];
    // Multi-audio is exposed via separate EXT-X-MEDIA renditions so the
    // player can switch audio client-side without a reload. Every rendition
    // is listed even when the user has picked a specific track — the picked
    // track is marked DEFAULT=YES so the player preselects it.
    const pickedIdx = this.activeStreamTracker.getAudioStreamIndex(mediaFileId);
    const muxFlavour: 'ts' | 'fmp4' = this.activeStreamTracker.getUseTs(
      mediaFileId,
    )
      ? 'ts'
      : 'fmp4';
    const useExtXMedia =
      pickAudioLayout(audioStreams.length, muxFlavour) === 'var-stream-map';
    const onlyQuality = firstQueryString(req.query, 'startQuality');
    // Device type: URL param wins (stream URL is built by the frontend with
    // the cached client profile); fall back to whatever playback-info stored.
    const deviceParam = firstQueryString(req.query, 'device');
    const deviceType: 'mobile' | 'desktop' =
      deviceParam === 'mobile' || deviceParam === 'desktop'
        ? deviceParam
        : this.activeStreamTracker.getDeviceType(mediaFileId);
    this.activeStreamTracker.setDeviceType(mediaFileId, deviceType);

    const sdrVariant = this.activeStreamTracker.getVideoVariant(mediaFileId);
    const sourceFrameRate = parseFloat(v?.frameRate ?? '') || undefined;
    const playlist = this.transcodingService.generateMasterPlaylist(
      mediaFileId,
      w,
      h,
      tokenParam,
      includeRemux,
      sourceBitrate || undefined,
      // Pass the array when we want EXT-X-MEDIA renditions, OR when the
      // source has zero audio streams — the empty array signals
      // `noAudio` to the master-playlist builder so CODECS drops the
      // audio entry (otherwise Shaka / ExoPlayer reject the variant).
      // `undefined` keeps the muxed single-audio layout for everyone else.
      useExtXMedia || audioStreams.length === 0 ? audioStreams : undefined,
      onlyQuality,
      pickedIdx ?? 0,
      deviceType,
      (this.activeStreamTracker.getAudioPlan(mediaFileId)?.codec ?? 'aac') as
        | 'aac'
        | 'ac3'
        | 'eac3',
      hdrPassThrough,
      // Only the SDR ladder branch consumes this — the HDR branch
      // already drives its codec strings from `hdrPassThrough`.
      sdrVariant && sdrVariant.hdr == null ? sdrVariant : undefined,
      sourceFrameRate,
    );

    this.activeStreamTracker.setAudioStreamCount(
      mediaFileId,
      audioStreams.length,
    );
    this.activeStreamTracker.setUseExtXMedia(mediaFileId, useExtXMedia);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.send(playlist);

    // Pre-spawn ffmpeg when we know the player will start at seg-0 (fresh
    // play, not resume). Usually a no-op when playback-info already
    // pre-warmed the session; acts as a safety net otherwise.
    const startAtRaw = firstQueryString(req.query, 'startAt');
    const startAt = startAtRaw != null ? parseFloat(startAtRaw) : undefined;
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

    // Audio is produced by the video session whenever the master picked the
    // var_stream_map layout (`setUseExtXMedia`). That's now true for any
    // fMP4 source with audio (issue #148, Tizen) and for multi-audio
    // sources regardless of mux flavour. Only the muxed TS / muxed-fMP4
    // legacy path needs a separate audio-only session as a fallback.
    const useExtXMedia =
      this.activeStreamTracker.getUseExtXMedia(mediaFileId);
    if (!useExtXMedia) {
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
      useTs ? undefined : `${basePath}/init_${audioIndex + 1}.mp4${tokenParam}`,
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
      const baseQuality = (profiles[0] ?? PROFILES[PROFILES.length - 1]).name;
      // Audio route can race ahead of the seek-restart's video session
      // being registered: it sees no session, falls into this branch
      // and spawns a brand-new one at the SDR top rung — which then
      // kills the in-flight HDR session via `getOrCreateSession`'s
      // quality-change path. Translate to the HDR rung when the master
      // is publishing the HDR ladder so the spawned session matches.
      const quality =
        this.activeStreamTracker.getHdrLadder(mediaFileId) &&
        !baseQuality.endsWith('-hdr')
          ? `${baseQuality}-hdr`
          : baseQuality;
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

    await this.serveCmafFile(res, segPath, segmentContentType(segment));
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
    // Tizen TV sessions can opt into MPEG-TS segments (no init segment)
    // to bypass AVPlay's HLS-fMP4 rejection (issue #148). The fMP4 path
    // is post-processed to CMAF (`cmaf-rewrite.ts`) so it works on
    // every other client; `useTs` is the emergency fallback.
    const segExt = useTs ? 'ts' : 'm4s';
    // var_stream_map writes per-variant under `<idx>/` with init_<idx>.mp4.
    // The remux session is video-only on multi-audio sources but does NOT
    // use var_stream_map (single output, init.mp4 + seg-N.m4s flat) —
    // forcing init_0.mp4 there serves a 404.
    const usesVarStreamMapLayout = multiAudio && quality !== 'remux';
    const initName = useTs
      ? undefined
      : usesVarStreamMapLayout
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
    //
    // The `quality` gate is load-bearing: when a prewarm session is running
    // on a different quality (e.g. 2160p H.264 prewarmed before the player
    // picked the remux variant), the wrong-layout init file (`0/init_0.mp4`
    // for var_stream_map vs flat `init.mp4` for remux) never appears, and
    // `getSegmentPath` waits the full 60s timeout before the slow path can
    // kill the old session and spawn the right one — a hard 60s stall to
    // first frame.
    const sessionQualityMatches =
      existing != null &&
      (quality === 'remux' ? !!existing.remux : existing.quality === quality);
    if (segment.startsWith('init') && existing && sessionQualityMatches) {
      const ma = this.activeStreamTracker.getUseExtXMedia(mediaFileId);
      // Same caveat as the segment path: remux video-only doesn't use
      // var_stream_map, so the `0/` prefix would 404 on the init lookup.
      const initFile = ma && quality !== 'remux' ? `0/${segment}` : segment;
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
        if (!initPath) continue;
        // 0-byte init.mp4: ffmpeg races between `creat()` and the first
        // moov write (no temp_file rename for inits). Poll the file
        // until it has bytes — beats giving up immediately, which
        // would surface as a terminal 404 on every player that
        // doesn't retry HTTP errors (ExoPlayer's
        // DefaultLoadErrorHandlingPolicy treats 404 as unrecoverable).
        // 5s is well above ffmpeg's typical write-the-moov latency
        // (~200-500 ms after spawn) and bounded so a permanently-
        // broken session can't hang the request forever.
        const ready = await awaitFileNonEmpty(initPath, 5000);
        if (!ready) {
          this.log.warn(
            `[init] 0-byte ${label} init.mp4 at ${initPath} after 5s — skipping`,
          );
          continue;
        }
        await this.serveCmafFile(res, initPath, segmentContentType(segment));
        return;
      }
    }

    const segMatch = segment.match(/seg-(\d+)\.(ts|m4s)/);
    const segIndex = segMatch ? parseInt(segMatch[1], 10) : 0;

    // If a session (running OR completed) already has this segment ON DISK,
    // serve it without any DB query or session management. Completed sessions
    // (exitCode !== null) still have valid segments in cache — don't skip them.
    if (existing && existing.quality === quality) {
      const varStreamMap =
        this.activeStreamTracker.getUseExtXMedia(mediaFileId);
      const segName =
        varStreamMap && quality !== 'remux' ? `0/${segment}` : segment;
      const segPath = `${existing.cachePath}/${segName}`;
      if (fs.existsSync(segPath)) {
        // Same 0-byte CDN-poisoning trap as the init handler above: a
        // racing segment write can leave an empty file on disk, and an
        // intermediate cache (Cloudflare with `Cache-Control: max-age`
        // by default) will pin that empty response under the URL.
        // Stat-check and refuse so the CDN never caches the broken
        // version, then mark every segment served from a live transcode
        // session un-cacheable for the same reason.
        const segStat = fs.statSync(segPath);
        if (segStat.size === 0) {
          sendTransientUnavailable(res);
          return;
        }
        existing.lastAccess = Date.now();
        await this.serveCmafFile(res, segPath, segmentContentType(segment));
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
          const earlyStat = fs.statSync(segPath);
          if (earlyStat.size === 0) {
            sendTransientUnavailable(res);
            return;
          }
          await this.serveCmafFile(res, segPath, segmentContentType(segment));
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

    // With var_stream_map (fMP4 + multi-audio), video segments are in
    // subdirectory "0/". The remux session keeps a flat layout (no
    // var_stream_map), so the `0/` prefix would 404 there.
    const varStreamMap = this.activeStreamTracker.getUseExtXMedia(mediaFileId);
    const usesVarStreamMapLayout = varStreamMap && quality !== 'remux';
    const segName = usesVarStreamMapLayout ? `0/${segment}` : segment;

    const segPath = await this.transcodingService.getSegmentPath(
      session,
      segName,
    );
    if (!segPath) {
      // ffmpeg session is healthy (exitCode === null) → segment will
      // arrive on the next tick; surface as transient so players retry.
      // Hard 404 only when the session actually died.
      if (session.process.exitCode === null) {
        this.log.warn(
          `Segment 503 (transient): ${segment} (quality=${quality}, mfid=${mediaFileId})`,
        );
        sendTransientUnavailable(res);
        return;
      }
      this.log.warn(
        `Segment 404: ${segment} (quality=${quality}, mfid=${mediaFileId}, exitCode=${session.process.exitCode})`,
      );
      res.status(404).send('Segment not found');
      return;
    }

    const finalStat = fs.statSync(segPath);
    if (finalStat.size === 0) {
      sendTransientUnavailable(res);
      return;
    }
    await this.serveCmafFile(res, segPath, segmentContentType(segment));
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
