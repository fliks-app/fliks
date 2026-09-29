import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
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
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CaslAbilityFactory } from '../auth/casl/casl-ability.factory';
import { Action } from '../auth/casl/actions.enum';
import { EventsService } from '../scheduler/events.service';
import { parseByteRange } from './byte-range.util';
import { User } from '../users/entities/user.entity';
import type { MediaFileInfo } from '../subtitles/ffprobe.service';
import { StreamingService, ResolvedFile } from './streaming.service';
import { SubtitleStreamService } from './subtitle-stream.service';
import {
  TranscodingService,
  PROFILES,
  getLadderForDevice,
  getHdrLadderForDevice,
  profileFitsSource,
  sourceBitrates,
  hdrRungName,
  cappedRungVideoBitrateBps,
  parseBitrateToBps,
  type BurnInSubtitle,
  type SessionContext,
  type TranscodeSession,
} from './transcoding';
import { tsHeadroom } from './transcoding/ffmpeg-args';
import {
  DEFAULT_SEGMENT_DURATION,
  EARLY_PROBE_SEGMENTS,
  parseSourceFps,
  realSegmentSeconds,
  secondsToSegmentIndex,
  frameSecondsOf,
  uniformSegmentCount,
} from './transcoding/constants';
import {
  gridSegmentIndex,
  remuxSegmentGrid,
  type KeyframeGrid,
} from './transcoding/segment-boundaries';
import {
  cueOffsetSeconds,
  inputSeekSeconds,
  sourceTimeline,
} from './transcoding/source-timeline';
import { copySourceCodecString } from './transcoding/codec/codec-strings';
import { dvSupplementalCodecs, dvStandaloneCodecs } from './transcoding/codec/dolby-vision';
import { LiveSessionRegistry, type LiveSession, type SessionKind } from './live-session.service';
import * as path from 'path';
import { SegmentPackagingService } from './services/segment-packaging.service';
import { SessionRouter } from './services/session-router.service';
import { SourceScanService } from './services/source-scan.service';
import { StaleProbeRescanService, needsReprobe } from './services/stale-probe-rescan.service';
import { SessionContextBuilder } from './services/session-context-builder.service';
import { sessionProfileHash } from './transcoding/session-profile';
import type { SourceScan } from './transcoding/source-scan';
import { audioLayout } from './transcoding/audio-layout';
import {
  buildIFrameSegmentArgs,
  iframeResolution,
} from './transcoding/iframe-trick-play';
import { autoFfmpegSlots } from '../../common/utils/ffmpeg-slots';
import { getPauseCapability } from './transcoding/ffmpeg-pause';
import {
  encodePipelineInputs,
  resolveEncodePipeline,
  resolveTonemapReport,
} from './transcoding/encode-pipeline';
import { ThumbnailService } from './thumbnail.service';
import { StreamBuilderService } from './stream-builder.service';
import { ActiveStreamTracker } from './active-stream-tracker.service';
import { SessionExpiredException } from './session-expired.exception';
import { SubtitleBurnInService } from './subtitle-burn-in.service';
import { PlaybackService } from './playback.service';
import { MarkersService } from '../markers/markers.service';
import { DeviceProfileDto } from './dto/device-profile.dto';
import { StreamingSettingsCache } from './streaming-settings-cache.service';
import { PluginPreRollService } from '../plugins/plugin-pre-roll.service';
import type { PreRollItem } from '../../common/plugin-contract';

// Derived from the ladders themselves (SDR + HDR, full + eco) so a new rung
// can never be forgotten here — the missing eco entry is exactly what 400'd
// `eco-1080p` and surfaced as Shaka error 1001.
const VALID_QUALITIES = new Set([
  ...getLadderForDevice(undefined).map((p) => p.name),
  ...getHdrLadderForDevice(undefined).map((p) => p.name),
  'remux',
]);

/** Inject the X-TIMESTAMP-MAP putting cue 0 at `cueOffsetSeconds` on the served
 *  timeline; a negative offset moves LOCAL instead, MPEGTS being unsigned. */
export function withTimestampMap(
  vtt: string | Buffer,
  cueOffsetSeconds = 0,
): string {
  const text = typeof vtt === 'string' ? vtt : vtt.toString('utf-8');
  const mpegts = Math.round(Math.max(0, cueOffsetSeconds) * 90000);
  const local = new Date(Math.round(Math.max(0, -cueOffsetSeconds) * 1000))
    .toISOString()
    .slice(11, 23);
  const map = `X-TIMESTAMP-MAP=MPEGTS:${mpegts},LOCAL:${local}`;
  return text.replace(/^(WEBVTT[^\n]*)\n/, `$1\n${map}\n`);
}

/**
 * Asks the plugin, then ACL-gates every candidate through the same `resolveFile` the main item
 * uses, for the same user: a plugin only names an id, it never grants access to one. Answers
 * `undefined` rather than `[]` so a plugin-free install serializes with `preRoll` absent.
 */
export async function resolvePreRoll<TUser>(deps: {
  ask: () => Promise<PreRollItem[]>;
  resolveFile: (mediaFileId: number, user: TUser) => Promise<unknown>;
  user: TUser;
}): Promise<PreRollItem[] | undefined> {
  const candidates = await deps.ask();
  if (!candidates.length) return undefined;
  const checks = await Promise.allSettled(candidates.map((c) => deps.resolveFile(c.mediaFileId, deps.user)));
  const allowed = candidates.filter((_, i) => checks[i].status === 'fulfilled');
  return allowed.length ? allowed : undefined;
}

/** Accepted HLS segment / init filenames (fMP4 init, fMP4 or TS segment). */
const SEGMENT_NAME_RE = /^(init(_\d+)?\.mp4|seg-\d{3,4}\.(m4s|ts))$/;

/**
 * Compose / append the `token=...` + `sid=...` query pair that every
 * streaming URL (manifest, variant, segment, audio) carries. The token
 * authenticates the request; the sid binds it to a
 * {@link LiveSessionRegistry} entry so segment endpoints can route to
 * the exact `(file, user, profileHash)` transcode session instead of
 * the most-recently-accessed heuristic fallback.
 *
 * When `base` is omitted the result is a leading query suffix
 * (`?token=...&sid=...` or empty); when supplied the params are
 * appended to the existing URL with the correct separator.
 */
function streamQuery(
  params: {
    token?: string | null;
    sid?: string | null;
  },
  base?: string,
): string {
  const parts: string[] = [];
  if (params.token) parts.push(`token=${encodeURIComponent(params.token)}`);
  if (params.sid) parts.push(`sid=${encodeURIComponent(params.sid)}`);
  if (!parts.length) return base ?? '';
  if (base == null) return `?${parts.join('&')}`;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${parts.join('&')}`;
}

/** Lift `?token=` and `?sid=` off the incoming request and serialise
 *  them back into a `?token=…&sid=…` suffix. Used to propagate the
 *  caller's auth + live-session handle into the segment / playlist
 *  URLs returned in HLS manifests. */
function buildTokenParam(req: Request): string {
  const token = firstQueryString(req.query, 'token');
  const sid = firstQueryString(req.query, 'sid');
  return streamQuery({ token, sid });
}

/** Pick the right HLS segment Content-Type. fMP4 (.m4s / .mp4) → video/mp4,
 *  MPEG-TS (.ts, used as the explicit `useTs` fallback for Tizen TVs on
 *  older firmwares — issue #148) → video/MP2T. */
function segmentContentType(segment: string): string {
  return segment.endsWith('.ts') ? 'video/MP2T' : 'video/mp4';
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
function sendTransientUnavailable(
  res: Response,
  retryAfterSec: number = 2,
): void {
  res.setHeader('Retry-After', String(retryAfterSec));
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.status(503).end();
}

/** `statSync().size`, or null when the file vanished — e.g. a seek-restart /
 *  teardown `rm` racing the read between getSegmentPath's existsSync and here.
 *  Callers treat null like a not-yet-ready segment (retryable 503) instead of
 *  letting the throw bubble to an uncaught 500. */
function statSizeOrNull(filePath: string): number | null {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

/** VOD playlist on the uniform grid: seg-N covers `[N, N+1) · segDuration` (the
 *  real length, `realSegmentSeconds`), as many as `uniformSegmentCount` finds. */
export function buildVodPlaylist(
  duration: number,
  segmentUrl: (index: string) => string,
  initUrl: string | undefined,
  segDuration: number,
  frameSeconds: number,
): string {
  const segCount = uniformSegmentCount(duration, segDuration, frameSeconds);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${Math.ceil(segDuration)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ];
  if (initUrl) {
    lines.push(`#EXT-X-MAP:URI="${initUrl}"`);
  }
  for (let i = 0; i < segCount; i++) {
    const segStart = i * segDuration;
    const segLen = Math.min(segDuration, duration - segStart);
    if (segLen <= 0) break;
    lines.push(`#EXTINF:${segLen.toFixed(3)},`);
    lines.push(segmentUrl(String(i).padStart(4, '0')));
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

/** I-frames-only playlist for AVPlay trick play: the variant's uniform grid
 *  (one forced IDR per segment), each entry pointing at a single-keyframe
 *  segment. See `iframe-trick-play.ts` for why the frames get their own URIs
 *  instead of byte ranges into the variant's segments. */
export function buildIFramePlaylist(
  duration: number,
  segmentUrl: (index: string) => string,
  segDuration: number,
  frameSeconds: number,
): string {
  return buildVodPlaylist(duration, segmentUrl, undefined, segDuration, frameSeconds).replace(
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-I-FRAMES-ONLY',
  );
}

function frameSeconds(
  streamInfo: { video?: { frameRate?: string }[] } | null | undefined,
): number {
  return frameSecondsOf(parseSourceFps(streamInfo?.video?.[0]?.frameRate));
}

/** Trick-play grid: the variant's real segment length, so entry N is the IDR
 *  the encoder forces at N * that. */
function iframeGrid(
  streamInfo: { video?: { frameRate?: string }[] } | null | undefined,
  segmentDuration: number,
): number {
  return realSegmentSeconds(
    segmentDuration,
    parseSourceFps(streamInfo?.video?.[0]?.frameRate),
  );
}

/** VOD playlist with explicit per-segment durations. Used by the remux/copy
 *  path, where ffmpeg cuts at source keyframes so segments are variable-length
 *  and a uniform `EXTINF` grid would mislead strict players (AVPlayer) into a
 *  progressive A/V drift. `durations` mirror ffmpeg's actual segment lengths
 *  (see {@link remuxSegmentGrid}). */
export function buildVariableVodPlaylist(
  durations: number[],
  segmentUrl: (index: string) => string,
  initUrl?: string,
): string {
  const target = Math.ceil(durations.reduce((m, d) => Math.max(m, d), 0));
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${target}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ];
  if (initUrl) {
    lines.push(`#EXT-X-MAP:URI="${initUrl}"`);
  }
  for (let i = 0; i < durations.length; i++) {
    lines.push(`#EXTINF:${durations[i].toFixed(3)},`);
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
    private readonly liveSessions: LiveSessionRegistry,
    private readonly segmentPackaging: SegmentPackagingService,
    private readonly sessionRouter: SessionRouter,
    private readonly sessionContextBuilder: SessionContextBuilder,
    private readonly sourceScans: SourceScanService,
    private readonly staleProbeRescan: StaleProbeRescanService,
    private readonly pluginPreRoll: PluginPreRollService,
    private readonly events: EventsService,
    private readonly caslAbilityFactory: CaslAbilityFactory,
  ) {}

  private getStreamingSettings() {
    return this.streamingSettingsCache.get();
  }


  /**
   * Effective resume offset in seconds. The explicit `startAt` query wins when
   * supplied (including `0` = restart from the top, which must override a saved
   * position); otherwise fall back to the saved playback position when it's a
   * meaningful resume (>10 s in, not finished), else 0. Shared by the prewarm
   * and the LiveSession `position` seed so the session's playhead matches where
   * ffmpeg actually starts — otherwise a resume that relies on the saved
   * position leaves `position` at 0, and a fresh main spawned off it anchors at
   * segment 0 instead of the resume segment.
   */
  private async resolveEffectiveStartAt(
    startAt: number | undefined,
    userId: number | undefined,
    mediaId: number | undefined,
    episodeId: number | undefined,
  ): Promise<number> {
    if (startAt !== undefined) return startAt;
    if (userId != null && mediaId != null) {
      const state = await this.playbackService.getState(
        userId,
        mediaId,
        episodeId,
      );
      if (state && !state.completed && state.positionSeconds > 10) {
        return state.positionSeconds;
      }
    }
    return 0;
  }

  /**
   * Highest segment the main session legitimately owns: the larger of its
   * current start and the live playhead. The playhead survives an in-memory
   * session loss (recovery re-seeds it), so a probe arriving after a restart
   * still floors at the resume point instead of segment 0.
   */
  private resumeFloor(
    live: { position: number } | null | undefined,
    existing:
      | {
          startSegment?: number | null;
          sourceFps?: number;
          segmentDuration?: number;
        }
      | null
      | undefined,
    remux?: { boundaries: number[]; origin: number },
  ): number {
    const posIndex = live
      ? remux
        ? gridSegmentIndex(remux.boundaries, live.position, remux.origin)
        : secondsToSegmentIndex(
            live.position,
            this.segDur(existing ?? undefined),
            existing?.sourceFps,
          )
      : 0;
    return Math.max(existing?.startSegment ?? 0, posIndex);
  }

  /** Segment duration for a request: the session's frozen grid when serving an
   *  existing session, else the current admin setting (which a spawn will
   *  freeze, so playlist and session agree). Never reads a mutable global. */
  private segDur(session?: { segmentDuration?: number }): number {
    return (
      session?.segmentDuration ?? this.activeStreamTracker.getSegmentDuration()
    );
  }

  /** Fallback playlist duration for a request with no keyframe grid: plain
   *  segDur for remux (its real, ungridded ffmpeg cut), the fps-aware GOP
   *  length otherwise (the forced-keyframe transcode grid). Shared by the
   *  video and audio-rendition playlists so a remux group never announces
   *  audio durations the video route wouldn't. */
  private fallbackSegDuration(isRemux: boolean, sourceFps: number | undefined): number {
    return isRemux ? this.segDur() : realSegmentSeconds(this.segDur(), sourceFps);
  }

  /** The keyframe grid a remux playback would keep, or null for the uniform one.
   *  Computed once per request so evaluate()'s AudioEndsEarly check and the grid actually served can never disagree. */
  private freezeRemuxGrid(
    scan: SourceScan | null,
    resolved: ResolvedFile,
    origin: number,
    segDur: number,
  ): KeyframeGrid | null {
    return scan
      ? remuxSegmentGrid(scan, origin, segDur, resolved.mediaFile.streamInfo?.video?.[0]?.frameRate)
      : null;
  }

  /** Logs why a remux session fell back to the uniform grid. Called only once the
   *  play method is known, so a DirectPlay/Transcode outcome never logs about it. */
  private logRemuxGridFallback(
    scan: SourceScan | null,
    resolved: ResolvedFile,
    grid: KeyframeGrid | null,
  ): void {
    if (!scan) {
      this.log.log(`${resolved.absolutePath} not scanned yet; remux on the uniform grid`);
    } else if (!grid) {
      this.log.warn(`No video keyframe in ${resolved.absolutePath}; uniform grid`);
    }
  }

  /**
   * Segment a freshly-spawned main should start at for a request. An init
   * segment is position-independent, so it anchors at the resume floor (the
   * session playhead) rather than its nominal segment 0; a real segment read
   * anchors at the requested segment. Single source of truth for resume
   * anchoring across the spawn paths that fire when the prewarm didn't pre-warm
   * the main — keeps them from diverging (the "fix one, miss the others" trap).
   */
  private anchorSegment(
    live: { position: number } | null | undefined,
    existing: { startSegment?: number | null } | null | undefined,
    isInit: boolean,
    segIndex: number,
    remux?: { boundaries: number[]; origin: number },
  ): number {
    return isInit ? this.resumeFloor(live, existing, remux) : segIndex;
  }

  /** No resolvable LiveSession means no codec variant to thread into ffmpeg
   *  (player torn down mid-flight, or a stale sid): 410 so the client
   *  re-establishes via playback-info, instead of spawning for nobody. */
  private assertVideoVariant(ctx: { videoVariant?: unknown }, req: Request): void {
    if (!ctx.videoVariant) {
      throw new SessionExpiredException(firstQueryString(req.query, 'sid') ?? null);
    }
  }

  /** Packaging options every segment/init serve shares: the session's real
   *  segment length and PTS origin. `keyframeCut` marks an already-assembled
   *  remux rendition, which must not be re-anchored a second time. */
  private async serveFrom(
    res: Response,
    segPath: string,
    segment: string,
    session: { segmentDuration?: number; sourceFps?: number; sourceStartPts?: number },
    keyframeCut = false,
  ): Promise<void> {
    await this.segmentPackaging.serve(res, segPath, segmentContentType(segment), {
      segDuration: realSegmentSeconds(this.segDur(session), session.sourceFps),
      startPts: session.sourceStartPts,
      keyframeCut,
    });
  }

  /** var_stream_map writes video files under `0/`; a remux session (video-only,
   *  flat layout) never uses it, so the prefix would 404 there. */
  private videoSegName(segment: string, quality: string, useExtXMedia: boolean): string {
    return useExtXMedia && quality !== 'remux' ? `0/${segment}` : segment;
  }

  /** 404 a real segment past the frozen remux grid before anchoring/spawning
   *  on it: past the end, that throws a RangeError instead of a session. */
  private rejectPastRemuxGrid(
    res: Response,
    segment: string,
    grid: KeyframeGrid | null,
    isInit: boolean,
    segIndex: number,
  ): boolean {
    if (!grid || isInit || segIndex < grid.durations.length) return false;
    this.log.warn(`Segment 404: ${segment} is past the ${grid.durations.length} of the remux grid`);
    res.status(404).send('Segment not found');
    return true;
  }

  /** Anchor + spawn a remux session for a request, 404ing (not killing the
   *  live run) when the segment falls past the frozen grid: null means the
   *  404 was already sent and the caller must return without serving. */
  private async spawnRemuxSession(
    res: Response,
    segment: string,
    mediaFileId: number,
    absolutePath: string,
    ctx: SessionContext,
    live: LiveSession | null | undefined,
    existing: { startSegment?: number | null } | null | undefined,
    isInit: boolean,
    segIndex: number,
    variantIndex?: number,
  ): Promise<TranscodeSession | null> {
    const grid = live?.remuxGrid ?? null;
    if (this.rejectPastRemuxGrid(res, segment, grid, isInit, segIndex)) return null;
    const startSeg = this.anchorSegment(
      live,
      existing,
      isInit,
      segIndex,
      grid ? { boundaries: grid.boundaries, origin: ctx.sourceStartPts ?? 0 } : undefined,
    );
    return this.transcodingService.getOrCreateRemuxSession(
      mediaFileId,
      absolutePath,
      startSeg,
      ctx,
      grid,
      variantIndex,
    );
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
    instanceIdOverride?: string | null,
  ): Promise<void> {
    if (!startQuality || startQuality === 'auto') return;
    try {
      const effectiveStartAt = await this.resolveEffectiveStartAt(
        startAt,
        req.user?.id,
        resolved.mediaFile.mediaId,
        resolved.mediaFile.episodeId ?? undefined,
      );
      const ctx = this.sessionContextBuilder.build(req, resolved, mediaFileId);
      ctx.spawnReason = 'prewarm';
      // playback-info carries no ?sid=, so the builder resolves the requester
      // via findCurrent — which in a concurrent burst can be the other viewer.
      // Pin the instance to the session we just created instead (#638).
      if (instanceIdOverride !== undefined) {
        ctx.instanceSuffix = instanceIdOverride ?? undefined;
      }
      const profileHash = this.transcodingService.computeProfileHashForCtx(ctx);
      const existing = this.transcodingService.getExistingSession(
        mediaFileId,
        req.user?.id,
        profileHash,
      );
      if (existing && existing.process.exitCode === null) return;

      // `remux` / `original` resolve to the player's actual rung only
      // after the manifest loads — Shaka filters variants whose
      // CODECS string the browser can't decode (HEVC Main10 L5.1 is
      // commonly filtered on web), so the top rung we'd guess from
      // the device ladder is often not what the player ends up
      // requesting. Skipping the prewarm for these pseudo-labels
      // avoids the spawn-then-kill dance; the player's first segment
      // fetch starts ffmpeg synchronously at the correct rung.
      if (startQuality === 'remux' || startQuality === 'original') return;
      const session = this.sessionRouter.findRequestSession(req, mediaFileId);
      // A pinned rung matching the source can still resolve to DirectStream
      // (e.g. a 1080p pin on a 1080p source): the client plays the 'remux'
      // session, so warming a transcode one here would run unwatched to EOF.
      if (session?.kind === 'remux') return;
      // When the HDR ladder is in effect, the master only publishes
      // `*-hdr` rungs. The frontend's saved quality is height-based
      // (`1080p`), so translate to the HDR equivalent so prewarm
      // doesn't spawn a doomed SDR session that the player will
      // immediately kill and replace with the matching HDR rung.
      const targetQuality = hdrRungName(startQuality, session?.hdrLadder ?? false);
      const startSegment = Math.max(
        0,
        secondsToSegmentIndex(
          effectiveStartAt,
          this.segDur(ctx),
          ctx.sourceFps,
        ),
      );

      // The seg-0 early-start companion runs in parallel with main and serves
      // seg-0 instantly while main encodes forward from seg-K. It only earns
      // its keep for engines that fetch seg-0 on a load-then-seek (Shaka /
      // Cast). Native engines (AVPlayer, ExoPlayer, AVPlay, webOS) seek
      // straight to seg-K and never request seg-0, so the parallel seg-0
      // transcode would be pure wasted GPU — skip it. Capability rides the
      // device profile and is stored on the session.
      if (startSegment > 0 && (session?.probesSegZero ?? true)) {
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

  /** Seconds from the first frame to the video's end, what every playlist of the
   *  session lasts; the probed container duration for a row without stream info. */
  private async resolveDuration(
    mediaFileId: number,
    req: Request,
    resolved: ResolvedFile,
  ): Promise<number> {
    const { absolutePath } = resolved;
    const timeline =
      this.sessionRouter.findRequestSession(req, mediaFileId)?.timeline ??
      sourceTimeline(resolved.mediaFile.streamInfo, absolutePath);
    if (timeline.end != null) return timeline.end - timeline.origin;
    try {
      const { stdout } = await execFileAsync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', absolutePath],
        { timeout: 10_000 },
      );
      return parseFloat(String(stdout).trim()) || 0;
    } catch (err) {
      this.log.warn(`Failed to probe duration for MediaFile #${mediaFileId}: ${err}`);
      return 0;
    }
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
    const video = info?.video?.[0];
    const sourceWidth = video?.width ?? 1920;
    const sourceHeight = video?.height ?? 1080;
    const sourceBitrate = info?.formatBitRate ?? 0;
    const duration = info?.durationSeconds ?? 0;

    // Offline playback keeps every audio rendition, so the download carries
    // one audio stream per source track, not one.
    const audioStreams = info?.audio ?? [];
    const audioTrackCount = Math.max(1, audioStreams.length);
    const sourceVideoBitrateBps = sourceBitrates(info).videoBitRate;

    const qualities: { key: string; label: string; estimatedSize: number }[] =
      [];
    for (const p of PROFILES) {
      if (!profileFitsSource(p, sourceWidth, sourceHeight)) continue;
      // The rung nominal is a ceiling, not what the encoder is told to emit:
      // a transcode is capped to the source bitrate, so quoting the nominal
      // overstated every download off a source below its rung — which is most
      // of them. This is the same function that produces the encoder's `-b:v`.
      // Codec: the estimate has no device profile, so it assumes the output
      // family matches the source, the common case and the lower bound (a
      // less efficient target gets proportionally more bits).
      const videoBps = cappedRungVideoBitrateBps(p, {
        outputCodec: video?.codec,
        sourceWidth,
        sourceHeight,
        sourceFrameRate: Number(video?.frameRate) || 0,
        sourceVideoBitrateBps,
        sourceVideoCodec: video?.codec,
      });
      const audioBps = parseBitrateToBps(p.audioBitrate) * audioTrackCount;
      let estimated =
        duration > 0
          ? Math.floor(((videoBps + audioBps) * duration) / 8)
          : Math.floor(
              fileSize * (videoBps / Math.max(sourceBitrate, videoBps)),
            );
      // A re-encode that came out larger than its source would be a bug, not a
      // download to warn the user about.
      if (fileSize > 0) estimated = Math.min(estimated, fileSize);
      qualities.push({
        key: p.name,
        label: p.name,
        estimatedSize: estimated,
      });
    }
    return qualities;
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

  /** Values the admin streaming form pre-fills the tuning fields with: the
   *  saved setting when there is one, otherwise what the env vars / host
   *  actually resolve to, so saving can never silently downgrade a budget the
   *  operator set in compose. */
  @Get('info/effective-settings')
  async effectiveSettingsInfo() {
    const ss = await this.getStreamingSettings();
    return {
      tonemapAlgo: ss.tonemapAlgo,
      gpuRenderNode: ss.gpuRenderNode,
      tonemapCurve: ss.tonemapCurve,
      cacheMaxGb: +(ss.cacheMaxBytes / 1024 ** 3).toFixed(1),
      cacheTtlHours: +(ss.cacheTtlMs / 3_600_000).toFixed(1),
      ffmpegSlots: ss.ffmpegSlots,
      ffmpegSlotsAuto: autoFfmpegSlots(),
      pauseCapability: getPauseCapability(),
    };
  }

  /** Detected GPUs for the admin device picker. `defaultNode` is what the
   *  `'auto'` selection currently resolves to; an empty `gpus` list tells the
   *  UI to hide the picker (single/opaque device, Windows/macOS). */
  @Get('info/gpus')
  gpusInfo() {
    return this.transcodingService.getGpus();
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
    const tokenParam = buildTokenParam(req);
    const burnInSubtitleRaw = firstQueryString(req.query, 'burnInSubtitleId');
    const burnInSubtitleId = burnInSubtitleRaw
      ? parseInt(burnInSubtitleRaw, 10)
      : undefined;

    // Resolved up front: the encode-pipeline decision needs its `type` too,
    // one resolve reused for both.
    let burnIn: BurnInSubtitle | null = null;
    if (burnInSubtitleId) {
      try {
        const info = await this.subtitleBurnIn.resolve(
          burnInSubtitleId,
          mediaFileId,
        );
        burnIn = {
          filter: this.subtitleBurnIn.buildFilter(info),
          streamIndex: info.streamIndex,
          type: info.type,
        };
      } catch (err) {
        this.log.warn(
          `Burn-in resolve failed for subtitle #${burnInSubtitleId}: ${err}`,
        );
      }
    }
    const audioStreamRaw = firstQueryString(req.query, 'audioStreamIndex');
    const audioStreamIndex =
      audioStreamRaw != null ? parseInt(audioStreamRaw, 10) : undefined;

    const ss = await this.getStreamingSettings();
    const user = req.user as User;
    const userId = user.id;

    // Extracting an embedded track reads the whole container, so start it now:
    // the menu is usually opened well after playback begins. No-op unless the
    // admin left prewarm on, and never blocks the response.
    void this.subtitleStreamService
      .warmupCache(
        resolved.absolutePath,
        mediaFileId,
        resolved.mediaFile.streamInfo?.subtitles,
        {
          title: resolved.media.title,
          mediaId: resolved.media.id,
          mediaType: resolved.media.type,
        },
        'playback',
      )
      .catch(() => {
        /* prewarm is best-effort — the on-demand path still serves the track */
      });

    // Never waits on a scan: an unscanned file plays without one and is scanned
    // for its next plays. Skipped on a stale row until the re-probe below chains it.
    const held = await this.sourceScans.lookup(
      mediaFileId,
      resolved.absolutePath,
      resolved.mediaFile.streamInfo,
    );
    const staleProbe = needsReprobe(resolved.mediaFile.streamInfo);
    if (!held.scan && !staleProbe) {
      void this.sourceScans.scheduleIfNeeded(
        mediaFileId,
        resolved.absolutePath,
        resolved.mediaFile.streamInfo,
      );
    }
    // Same fire-and-forget shape: a stale probe plays on its fallback now and
    // is backfilled for later plays, never blocking this one.
    void this.staleProbeRescan.scheduleIfNeeded(
      mediaFileId,
      resolved.absolutePath,
      resolved.mediaFile.streamInfo,
    );

    // For the session contexts later HLS requests build from them.
    this.activeStreamTracker.setSegmentDuration(ss.segmentDuration);
    this.activeStreamTracker.setTonemapAlgo(ss.tonemapAlgo);
    this.activeStreamTracker.setAutoCropEnabled(ss.autoCropEnabled);
    // Re-push the admin settings (GPU pin, cache budget, job slots) so a
    // change applies without a restart.
    this.transcodingService.applyStreamingSettings(ss);

    // Quality the client is requesting (absent / 'auto' = let the server
    // decide per autoQualityMode; 'original' = source rung; anything else =
    // a lower rung that must transcode). Drives DirectPlay-vs-ladder routing.
    const startQuality = firstQueryString(req.query, 'startQuality');
    // Frozen once, before the play-method decision, so evaluate()'s AudioEndsEarly
    // check and the grid this request serves (the LiveSession's remuxGrid) agree.
    const timeline = sourceTimeline(resolved.mediaFile.streamInfo, resolved.absolutePath);
    // Frozen alongside the timeline: a mid-session re-probe must not move the
    // grid a later seek respawn or playlist read on this session computes from.
    const sourceFps = parseSourceFps(resolved.mediaFile.streamInfo?.video?.[0]?.frameRate);
    const remuxGrid = this.freezeRemuxGrid(
      held.scan,
      resolved,
      timeline.origin,
      ss.segmentDuration,
    );
    const evaluateResult = this.streamBuilder.evaluate({
      resolved,
      profile: deviceProfile,
      tokenParam,
      settings: ss,
      // A failed resolve (burnIn still null) must not tell evaluate() there's
      // a burn-in — that loses DirectPlay for a subtitle nothing will render.
      burnInSubtitleId: burnIn ? burnInSubtitleId : undefined,
      burnInIsText: !!burnIn?.filter,
      requestedQuality: startQuality,
      audioStreamIndex,
      sourceScan: held.scan,
      remuxGrid,
    });
    const { response, useHdrLadder, videoVariant, muxFlavour } = evaluateResult;
    const sourceAudioCount = resolved.mediaFile.streamInfo?.audio?.length ?? 0;
    const effectiveUseTs = muxFlavour === 'ts';
    const deviceType = deviceProfile.deviceType ?? 'desktop';
    const useExtXMedia = audioLayout(sourceAudioCount) === 'var-stream-map';

    // Different device profiles (codec / mux / audio layout) hash to
    // different session-map keys, so multi-device playback of the same
    // file lands on coexisting sessions instead of mutually killing one
    // another. No drift kill needed: a hop from browser → cast spawns a
    // new session under the cast's profileHash and leaves the browser's
    // session untouched.
    const startAtRaw = firstQueryString(req.query, 'startAt');
    const startAt = startAtRaw != null ? parseFloat(startAtRaw) : undefined;
    // Offline download: the native DownloadManager pulls segments straight off
    // the HLS routes (no heartbeat channel), and the download can be paused.
    // Pin the session so it outlives the short playback TTL.
    const isDownload = firstQueryString(req.query, 'download') === '1';

    // Mark a new watch-history entry (history = sessions started).
    // Fire-and-forget — a DB hiccup should not block stream start.
    // Skipped for downloads: fetching for offline isn't watching, so it
    // shouldn't land in history / "continue watching".
    if (!isDownload && user?.id && resolved.mediaFile.mediaId) {
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

    const preRoll = await resolvePreRoll({
      ask: () =>
        this.pluginPreRoll.ask({
          mediaFileId,
          mediaId: resolved.mediaFile.mediaId,
          episodeId: episodeId ?? undefined,
          principal: { kind: 'delegated', userId },
        }),
      resolveFile: (id, forUser) => this.streamingService.resolveFile(id, forUser),
      user,
    });

    // The session's layout fields, stored on the LiveSession below and hashed
    // through the same function every HLS request rebuilds its context with.
    const sessionLayout = {
      useTs: effectiveUseTs,
      audioPlan: response.audioPlan,
      audioTrackPlans: evaluateResult.audioPlans,
      videoVariant,
      timeline,
      sourceVersion: held.version,
      dolbyVision: response.dolbyVision ?? false,
      sourceHdr10Plus: resolved.mediaFile.streamInfo?.video?.[0]?.hdr10Plus ?? false,
      sourceDvProfile: resolved.mediaFile.streamInfo?.video?.[0]?.dvProfile ?? null,
      sourceDvBlSignalCompatId:
        resolved.mediaFile.streamInfo?.video?.[0]?.dvBlSignalCompatId ?? null,
      audioStreams: resolved.mediaFile.streamInfo?.audio ?? null,
      // The would-transcode decision, not `response.tonemapping`: a remux
      // session (tonemapping: false) can still later serve a transcoded rung
      // under the same sid, which must tonemap too.
      tonemapping: evaluateResult.transcodeTonemapping,
      // Frozen from the admin setting: a later curve change must not move an
      // in-progress session's cache dir or mix segments of both curves.
      tonemapCurve: ss.tonemapCurve,
    };
    const profileHash =
      response.playMethod === 'DirectPlay'
        ? null
        : sessionProfileHash(
            sessionLayout,
            resolved.mediaFile.streamInfo,
            resolved.absolutePath,
            ss.segmentDuration,
          );
    const kind =
      response.playMethod === 'DirectPlay'
        ? 'directplay'
        : response.playMethod === 'DirectStream'
          ? 'remux'
          : 'transcode';
    if (kind === 'remux') this.logRemuxGridFallback(held.scan, resolved, remuxGrid);
    const deviceLabel: string | null = req.get('user-agent') ?? null;
    const sseConnectionId = req.get('x-fliks-sse-connection') ?? null;

    // Seed the session playhead with the effective resume offset, not the raw
    // `startAt`: a client that resumes by relying on the saved position (no
    // `startAt` query) would otherwise leave `position` at 0, and a fresh main
    // spawned off `position` (segment-handler race) would anchor at segment 0.
    const resumePosition = await this.resolveEffectiveStartAt(
      startAt,
      userId,
      resolved.mediaFile.mediaId,
      episodeId ?? undefined,
    );

    // Surface the tonemap mechanism the session actually runs, not the admin
    // pick: the spawn's own pipeline inputs, through the resolver ffmpeg-args uses.
    const v0 = resolved.mediaFile.streamInfo?.video?.[0];
    const pipelineInputs = encodePipelineInputs({
      hwAccel: this.transcodingService.getDetectedHwAccel(),
      crop: ss.autoCropEnabled && v0?.crop != null,
      textBurnIn: !!burnIn?.filter,
      tonemap: !!response.tonemapping,
      tonemapAlgo: ss.tonemapAlgo,
      sourceVideoCodec: (v0?.codec ?? '').toLowerCase() || undefined,
      isSourceHdr: !!v0?.hdrFormat,
      sourceDvProfile: v0?.dvProfile,
      sourceDvBlSignalCompatId: v0?.dvBlSignalCompatId,
    });
    const tonemapReport =
      response.tonemapping && videoVariant
        ? resolveTonemapReport(resolveEncodePipeline(videoVariant, pipelineInputs), {
            tonemap: true,
            dvNoBase: pipelineInputs.dvNoBase,
            burnIn: !!burnIn,
            sourceVideoCodec: pipelineInputs.sourceVideoCodec,
            hdr10Target: pipelineInputs.dvNoBase && videoVariant.hdr === 'HDR10',
            curve: ss.tonemapCurve,
          })
        : null;
    const tonemapAlgo = tonemapReport?.path ?? null;
    const tonemapCurve = tonemapReport?.curve;

    // A launch from another device counts for whoever started it. Resolved here
    // because this is where the playback that claims it actually begins.
    const attributionTargetId = this.events.targetIdFor(sseConnectionId);
    const attributedUserId = this.events.takeAttribution(
      attributionTargetId,
      mediaFileId,
    );
    this.log.debug(
      `Session for file ${mediaFileId} on target ${attributionTargetId ?? 'none'}` +
        ` (sse ${sseConnectionId ?? 'none'}) attributed to ${attributedUserId ?? 'its own account'}`,
    );

    // The LiveSession owns every per-playback setting: future HLS
    // requests resolve it via `?sid=...` and read settings straight off
    // this entry — no shared per-file mutable state to clobber.
    const liveSession = this.liveSessions.create({
      userId: userId ?? null,
      attributedUserId,
      username: user.username ?? null,
      mediaFileId,
      mediaTitle: resolved.media?.title ?? null,
      mediaType: resolved.media?.type ?? null,
      posterUrl: resolved.media?.posterUrl ?? null,
      profileHash,
      quality: typeof startQuality === 'string' ? startQuality : null,
      kind,
      deviceLabel,
      systemName: deviceProfile.systemName ?? null,
      appVersion: deviceProfile.appVersion ?? null,
      sseConnectionId,
      position: resumePosition,
      ...sessionLayout,
      sourceFps,
      remuxGrid: kind === 'remux' ? remuxGrid : null,
      audioStreamIndex: audioStreamIndex ?? null,
      audioStreamCount: sourceAudioCount,
      useExtXMedia,
      deviceType,
      hdrLadder: useHdrLadder,
      supportsHlsSubtitles: !!deviceProfile.supportsHlsSubtitles,
      dedupesAudioByLanguage: deviceProfile.dedupesAudioByLanguage,
      supportsIFrameTrickPlay: !!deviceProfile.supportsIFrameTrickPlay,
      probesSegZero: deviceProfile.probesSegZero,
      supportsAbr: deviceProfile.supportsAbr,
      clientTonemap: response.clientTonemap ?? false,
      transcodeReasons: response.transcodeReasons,
      burnIn,
      encoderPreset: ss.qsvPreset,
      canCopyVideo: response.videoCopyStream,
      pinned: isDownload,
    });

    // Pre-spawn ffmpeg for the segment the player will soon request. Skipped
    // for DirectPlay/auto (nothing to warm) and DirectStream (a pinned rung
    // there still plays through the 'remux' session, never this transcode
    // one, which would then run unread to EOF). Fire-and-forget.
    if (response.playMethod === 'Transcode') {
      void this.prewarmTranscodeSession(
        mediaFileId,
        resolved,
        req,
        startQuality,
        startAt,
        deviceType,
        liveSession.instanceId,
      );
    }

    // Bake the sessionId into the playUrl so every subsequent manifest /
    // segment request the player issues carries it. Manifest endpoints
    // propagate the same `sid` into the variant + segment URLs they
    // generate, so the segment-serving routes can look up the exact
    // `(file, user, profileHash)` session without heuristics.
    const playUrlWithSid = streamQuery(
      { sid: liveSession.sessionId },
      response.playUrl,
    );

    return {
      ...response,
      playUrl: playUrlWithSid,
      tonemapAlgo,
      tonemapCurve,
      durationSeconds: duration,
      markers,
      chapters,
      preRoll,
      sessionId: liveSession.sessionId,
      profileHash,
    };
  }

  /**
   * Explicit stop signal from the client (player destroy / page unload,
   * fetched with `keepalive: true`). Drops the live-session entry AND
   * kills the matching ffmpeg job — scoped to the `(user, file,
   * profileHash)` carried by the session, so a multi-device viewer
   * closing one device leaves every other device's stream untouched.
   * Cache is preserved across the kill. Idempotent — silently 204 on
   * unknown sessionIds.
   */
  @Delete('sessions/:sessionId')
  @HttpCode(204)
  stopLiveSession(
    @Param('sessionId') sessionId: string,
    @CurrentUser() user: User | undefined,
  ) {
    const live = this.liveSessions.get(sessionId);

    // Sids travel in HLS URLs, so a bare ownership-blind stop would let any
    // authenticated user end anyone else's playback.
    if (live?.userId != null && live.userId !== user?.id) {
      const allowed =
        !!user &&
        this.caslAbilityFactory
          .createForUser(user)
          .can(Action.Manage, 'Settings');
      if (!allowed) {
        this.log.warn(
          `Refused: user ${user?.id ?? 'unknown'} tried to stop session ${sessionId} owned by user ${live.userId}`,
        );
        throw new ForbiddenException('Not your session');
      }
    }

    if (live?.userId != null) {
      const stoppedTargetId = this.events.targetIdFor(live.sseConnectionId);
      if (stoppedTargetId) {
        this.log.debug(
          `stopLiveSession(${sessionId}): announcing the stop of ${stoppedTargetId}`,
        );
        this.events.emitToUser(live.userId, {
          type: 'remote.stopped',
          targetId: stoppedTargetId,
        });
      } else {
        // Silent until now, and the one branch that leaves a controller showing
        // playback that has ended.
        this.log.debug(
          `stopLiveSession(${sessionId}): no live target for connection ` +
            `${live.sseConnectionId ?? 'null'}, no stop announced`,
        );
      }
      this.events.emitToUser(live.userId, { type: 'remote.targets_changed' });
    } else {
      this.log.debug(
        `stopLiveSession(${sessionId}): no owning user to notify (${live ? 'shared device session' : 'already gone'})`,
      );
    }

    this.liveSessions.stop(sessionId);
    if (!live || !live.profileHash) return;
    // Only kill the underlying ffmpeg job(s) when no other live
    // session is still referencing this (user, file, profileHash) —
    // multi-tab or multi-device viewers sharing one ffmpeg should keep
    // it alive while at least one consumer remains. The cleanup loop
    // will reap the job 60 s after the last viewer leaves.
    const remaining = this.liveSessions.listForJob(
      live.userId,
      live.mediaFileId,
      live.profileHash,
    );
    if (remaining.length > 0) return;
    this.transcodingService.killSessionsForJob(
      live.mediaFileId,
      live.userId ?? undefined,
      live.profileHash,
    );
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
    this.sessionRouter.assertFresh(req);
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

    const tokenParam = buildTokenParam(req);

    const includeRemux = firstQueryString(req.query, 'remux') === '1';
    const live = this.sessionRouter.findRequestSession(req, mediaFileId);
    // HDR ladder eligibility — decided by stream-builder at playback-info
    // time and stored on the LiveSession. Independent from `includeRemux`:
    // even a /master.m3u8 without `?remux=1` should emit the HDR ladder
    // when the source + client combination warrant it.
    const sourceHdrFormat = v?.hdrFormat as 'HDR10' | 'HLG' | undefined;
    // The selector's chosen variant, frozen on the session at playback-info.
    // The HDR branch needs it to emit the right CODECS string per rung (HEVC
    // Main10 vs native AV1 HDR); the SDR branch reuses it below. Gate the HDR
    // pass-through on the stored variant actually being HDR (defensive against
    // an SDR variant left behind a stale hdrLadder flag).
    const liveVariant = live?.videoVariant ?? null;
    // A no-base DV source (e.g. P5) has no `sourceHdrFormat`; the live
    // variant's HDR format (set by evaluate()) is the fallback source of truth.
    const hdrFormat = sourceHdrFormat ?? liveVariant?.hdr ?? undefined;
    const hdrPassThrough =
      (live?.hdrLadder ?? false) && hdrFormat && liveVariant?.hdr != null
        ? {
            hdrFormat,
            hdrVariant: liveVariant,
            videoBitRateBps: v?.bitRate ?? undefined,
          }
        : undefined;
    // Frozen at playback-info, like the segments' own layout.
    const audioStreams = live?.audioStreams ?? si?.audio ?? [];
    // Multi-audio is exposed via separate EXT-X-MEDIA renditions so the
    // player can switch audio client-side without a reload. Every rendition
    // is listed even when the user has picked a specific track — the picked
    // track is marked DEFAULT=YES so the player preselects it.
    const pickedIdx = live?.audioStreamIndex ?? null;
    const useExtXMedia = audioLayout(audioStreams.length) === 'var-stream-map';
    const onlyQuality = firstQueryString(req.query, 'startQuality');
    // Device type: URL param wins (stream URL is built by the frontend with
    // the cached client profile); fall back to whatever playback-info stored.
    const deviceParam = firstQueryString(req.query, 'device');
    const deviceType: 'mobile' | 'desktop' =
      deviceParam === 'mobile' || deviceParam === 'desktop'
        ? deviceParam
        : (live?.deviceType ?? 'desktop');
    // Client-side ABR capability, frozen on the session at playback-info. A request
    // with no live session (a stale sid) defaults to the full ladder.
    const supportsAbr = live?.supportsAbr ?? true;
    // Persist the master.m3u8 decisions back on the session so segment
    // requests stay coherent (especially for the URL-override device
    // and the audio layout that callers downstream gate on).
    if (live) {
      this.liveSessions.update(live.sessionId, {
        deviceType,
        audioStreamCount: audioStreams.length,
        useExtXMedia,
      });
    }

    // Native HLS subtitle renditions — gated by the client's
    // `supportsHlsSubtitles` capability (sent in the device profile at
    // playback-info, stored on the session), so cues render inside the
    // player pipeline (PiP / AirPlay / lock-screen). Decoupled from the
    // video transcode: each rendition wraps the WebVTT the subtitle service
    // already extracts. Web (Shaka) leaves the flag off and keeps fetching
    // sidecar VTT.
    const subtitleRenditions =
      (live?.supportsHlsSubtitles ?? false)
        ? await this.subtitleStreamService
            .listTextSubtitleRenditions(mediaFileId, req.user as User)
            .catch((e) => {
              this.log.warn(
                `subtitle renditions failed for #${mediaFileId}: ${e instanceof Error ? e.message : e}`,
              );
              return undefined;
            })
        : undefined;

    const sdrVariant = liveVariant;
    // Frozen at playback-info: a mid-session re-probe must not move the
    // FRAME-RATE attribute or the I-frame grid the segments were cut on.
    const sourceFrameRate = live?.sourceFps ?? parseSourceFps(v?.frameRate);
    // The group's renditions (a remux copy also muxes every track, one per
    // EXT-X-MEDIA rendition), or the muxed track alone.
    const audioPlans = useExtXMedia
      ? (live?.audioTrackPlans ?? undefined)
      : live?.audioPlan
        ? [live.audioPlan]
        : undefined;
    // A no-base DV remux (P5, or P10.0) has no base layer: its standalone
    // CODECS string (always PQ) replaces the probed one, never alongside it.
    const remuxDvStandalone =
      includeRemux && live?.dolbyVision ? dvStandaloneCodecs(v) : null;
    // Same derivation as playback-info's remuxMasterBandwidthBps.
    const bitrates = sourceBitrates(si);
    const playlist = this.transcodingService.generateMasterPlaylist({
      mediaFileId,
      sourceWidth: w,
      sourceHeight: h,
      remuxWidth: v?.width,
      remuxHeight: v?.height,
      tokenParam,
      includeRemux,
      // Pass the array when we want EXT-X-MEDIA renditions, OR when the
      // source has zero audio streams — the empty array signals
      // `noAudio` to the master-playlist builder so CODECS drops the
      // audio entry (otherwise Shaka / ExoPlayer reject the variant).
      // `undefined` keeps the muxed single-audio layout for everyone else.
      audioStreams:
        useExtXMedia || audioStreams.length === 0 ? audioStreams : undefined,
      audioPlans,
      onlyQuality,
      defaultAudioIndex: pickedIdx ?? 0,
      deviceType,
      supportsAbr,
      dedupesAudioByLanguage: live?.dedupesAudioByLanguage ?? false,
      hdrPassThrough,
      // Only the SDR ladder branch consumes this — the HDR branch
      // already drives its codec strings from `hdrPassThrough`.
      sdrVariant: sdrVariant && sdrVariant.hdr == null ? sdrVariant : undefined,
      // Copied stream: describe the bitstream as probed, not as a rung would
      // encode it (see copySourceCodecString).
      remuxCodecs:
        includeRemux && v ? (remuxDvStandalone ?? copySourceCodecString(v)) : undefined,
      remuxSupplementalCodecs:
        includeRemux && live?.dolbyVision ? dvSupplementalCodecs(v) : undefined,
      formatBitRate: bitrates.formatBitRate,
      sourceFrameRate,
      sourceHdrFormat: remuxDvStandalone ? 'HDR10' : sourceHdrFormat,
      subtitleRenditions,
      sourceVideoBitrateBps: bitrates.videoBitRate,
      sourceVideoCodec: (v?.codec ?? '').toLowerCase() || undefined,
      // Trick play rides the same IDR grid as the variant, so the frame the
      // playlist promises at index N is the one the encoder puts there.
      iFrameTrickPlaySegmentSeconds: (live?.supportsIFrameTrickPlay ?? false)
        ? realSegmentSeconds(this.segDur(), sourceFrameRate)
        : undefined,
    });

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

  // Trick-play routes, like the subtitle ones below, MUST be registered before
  // :mediaFileId/:quality/*, or "iframe" parses as a quality.

  /** I-frames-only playlist backing the master's `EXT-X-I-FRAME-STREAM-INF`. */
  @Get(':mediaFileId/iframe/index.m3u8')
  async iframePlaylist(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    this.sessionRouter.assertFresh(req);
    const resolved = await this.streamingService.resolveFile(
      mediaFileId,
      req.user as User,
    );
    const durationHint = firstQueryString(req.query, 'duration');
    const duration =
      (durationHint ? parseFloat(durationHint) : 0) ||
      (await this.resolveDuration(mediaFileId, req, resolved));
    if (!duration) {
      res.status(404).send('Duration unknown — rescan the file first');
      return;
    }
    const tokenParam = buildTokenParam(req);
    const playlist = buildIFramePlaylist(
      duration,
      (seg) => `/api/stream/${mediaFileId}/iframe/seg-${seg}.ts${tokenParam}`,
      iframeGrid(resolved.mediaFile.streamInfo, this.segDur()),
      frameSeconds(resolved.mediaFile.streamInfo),
    );
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.send(playlist);
  }

  /** One trick-play keyframe, decoded from the source and muxed to MPEG-TS.
   *  Independent of the transcode session: a scan must not seek the running
   *  ffmpeg and respawn it at every frame. */
  @Get(':mediaFileId/iframe/:segment')
  async iframeSegment(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Param('segment') segment: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const match = /^seg-(\d+)\.ts$/.exec(segment);
    if (!match) {
      throw new BadRequestException(`Invalid trick-play segment: ${segment}`);
    }
    const resolved = await this.streamingService.resolveFile(
      mediaFileId,
      req.user as User,
    );
    const si = resolved.mediaFile.streamInfo;
    const v = si?.video?.[0];
    const crop = v?.crop;
    const { width, height } = iframeResolution(
      crop?.width ?? v?.width ?? 1920,
      crop?.height ?? v?.height ?? 1080,
    );
    const timeline = sourceTimeline(si, resolved.absolutePath);
    const args = buildIFrameSegmentArgs({
      inputPath: resolved.absolutePath,
      seekSeconds: inputSeekSeconds(
        parseInt(match[1], 10) * iframeGrid(si, this.segDur()),
        timeline,
      ),
      width,
      height,
      crop,
      timelineOffsetSeconds: tsHeadroom(timeline.origin),
    });
    try {
      // One ffmpeg pass per frame, uncached (~380 ms on 1080p): this is why
      // the client stops at 2x.
      const { stdout } = await execFileAsync('ffmpeg', args, {
        encoding: 'buffer',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 20_000,
      });
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(stdout);
    } catch {
      // A refused frame must stay retryable: AVPlay drops trick play on a 404.
      sendTransientUnavailable(res);
    }
  }

  // Subtitle VTT routes MUST be registered before :mediaFileId/:quality/* — otherwise
  // paths like /123/subtitles/456 match :quality=:segment and fail with "Invalid quality: subtitles".

  /** Extract an embedded subtitle stream as WebVTT (before :subtitleId so "embedded" is not parsed as id). */
  @Get(':mediaFileId/subtitles/embedded/:streamIndex')
  async embeddedSubtitle(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Param('streamIndex', ParseIntPipe) streamIndex: number,
    @CurrentUser() user: User | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // resolveFile also re-checks library access.
    const resolved = await this.streamingService.resolveFile(mediaFileId, user);
    const cueOffset = cueOffsetSeconds(
      this.sessionRouter.findRequestSession(req, mediaFileId)?.timeline ??
        sourceTimeline(resolved.mediaFile.streamInfo, resolved.absolutePath),
    );
    const stream = await this.subtitleStreamService.extractEmbeddedSubtitle(
      mediaFileId,
      streamIndex,
      user,
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
    res.send(withTimestampMap(vtt, cueOffset));
  }

  /** Embedded stream: only the extracted WebVTT exists, no sidecar file. */
  @Get(':mediaFileId/subtitles/embedded/:streamIndex/download')
  async embeddedSubtitleDownload(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Param('streamIndex', ParseIntPipe) streamIndex: number,
    @CurrentUser() user: User | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const resolved = await this.streamingService.resolveFile(mediaFileId, user);
    const cueOffset = cueOffsetSeconds(
      this.sessionRouter.findRequestSession(req, mediaFileId)?.timeline ??
        sourceTimeline(resolved.mediaFile.streamInfo, resolved.absolutePath),
    );
    const stream = await this.subtitleStreamService.extractEmbeddedSubtitle(
      mediaFileId,
      streamIndex,
      user,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const base = path.basename(
      resolved.relativePath,
      path.extname(resolved.relativePath),
    );
    // attachment() emits both `filename` and `filename*` — a client reading
    // only the plain one still gets a name.
    res.attachment(`${base}.track-${streamIndex}.vtt`);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.send(withTimestampMap(Buffer.concat(chunks), cueOffset));
  }

  /** Download an external subtitle as stored on disk, original format kept. */
  @Get(':mediaFileId/subtitles/:subtitleId/download')
  async subtitleDownload(
    @Param('subtitleId', ParseIntPipe) subtitleId: number,
    @CurrentUser() user: User | undefined,
    @Res() res: Response,
  ) {
    const { path: filePath, filename } =
      await this.subtitleStreamService.getSubtitleFileForDownload(
        subtitleId,
        user,
      );
    res.attachment(filename);
    res.sendFile(filePath);
  }

  /** Serve an external subtitle as WebVTT. */
  @Get(':mediaFileId/subtitles/:subtitleId')
  async subtitle(
    @Param('subtitleId', ParseIntPipe) subtitleId: number,
    @CurrentUser() user: User | undefined,
    @Res() res: Response,
  ) {
    const { vtt, cueOffsetSeconds } =
      await this.subtitleStreamService.getSubtitleAsVtt(subtitleId, user);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(withTimestampMap(vtt, cueOffsetSeconds));
  }

  // HLS subtitle media playlists (single WebVTT segment) — referenced by the
  // master's SUBTITLES group. The extra `/index.m3u8` segment keeps these
  // from colliding with the plain VTT routes above. Embedded route is
  // declared first so "embedded" is never read as a numeric subtitleId.

  /** Subtitle media playlist for an embedded stream. */
  @Get(':mediaFileId/subtitles/embedded/:streamIndex/index.m3u8')
  async embeddedSubtitlePlaylist(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Param('streamIndex', ParseIntPipe) streamIndex: number,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.sendSubtitlePlaylist(
      res,
      req,
      mediaFileId,
      `subtitles/embedded/${streamIndex}`,
    );
  }

  /** Subtitle media playlist for an external subtitle file. */
  @Get(':mediaFileId/subtitles/:subtitleId/index.m3u8')
  async externalSubtitlePlaylist(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Param('subtitleId', ParseIntPipe) subtitleId: number,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.sendSubtitlePlaylist(
      res,
      req,
      mediaFileId,
      `subtitles/${subtitleId}`,
    );
  }

  /** Build + send a single-segment VOD WebVTT media playlist whose one
   *  segment is the matching VTT endpoint. Native HLS players consume this
   *  as a SUBTITLES rendition so cues render inside the player pipeline
   *  (PiP / AirPlay / lock-screen) rather than an app overlay. The VTT
   *  itself carries the `X-TIMESTAMP-MAP` (via `withTimestampMap`) needed to
   *  align cue times with the media timeline. */
  private async sendSubtitlePlaylist(
    res: Response,
    req: Request,
    mediaFileId: number,
    vttPath: string,
  ): Promise<void> {
    const resolved = await this.streamingService.resolveFile(
      mediaFileId,
      req.user as User,
    );
    const duration = resolved.mediaFile.streamInfo?.durationSeconds ?? 0;
    const tokenParam = buildTokenParam(req);
    const target = Math.max(1, Math.ceil(duration || 1));
    const playlist = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      `#EXT-X-TARGETDURATION:${target}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      `#EXTINF:${(duration || target).toFixed(3)},`,
      `/api/stream/${mediaFileId}/${vttPath}${tokenParam}`,
      '#EXT-X-ENDLIST',
    ].join('\n');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.send(playlist);
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
    this.sessionRouter.assertFresh(req);
    const resolved = await this.streamingService.resolveFile(
      mediaFileId,
      req.user as User,
    );
    const duration = await this.resolveDuration(mediaFileId, req, resolved);
    if (!duration) {
      res.status(404).send('Duration unknown');
      return;
    }

    // The master lists audio renditions only in the var_stream_map layout, so
    // the video session cuts them, on its GOP grid (`hlsAudioSegment`).
    const live = this.sessionRouter.findRequestSession(req, mediaFileId);
    const tokenParam = buildTokenParam(req);
    const basePath = `/api/stream/${mediaFileId}/audio/${audioIndex}`;
    const useTs = live?.useTs ?? false;
    const segExt = useTs ? 'ts' : 'm4s';
    const initUrl = useTs
      ? undefined
      : `${basePath}/init_${audioIndex + 1}.mp4${tokenParam}`;
    const segmentUrl = (seg: string) =>
      `${basePath}/seg-${seg}.${segExt}${tokenParam}`;
    // A remux rendition is cut on the video's own keyframe grid
    // (`RemuxSegmentAssembler`); a uniform grid would desync its durations.
    const isRemux = live?.kind === 'remux';
    const remuxDurations = isRemux ? (live.remuxGrid?.durations ?? null) : null;
    const playlist = remuxDurations
      ? buildVariableVodPlaylist(remuxDurations, segmentUrl, initUrl)
      : buildVodPlaylist(
          duration,
          segmentUrl,
          initUrl,
          this.fallbackSegDuration(
            isRemux,
            live?.sourceFps ??
              parseSourceFps(resolved.mediaFile.streamInfo?.video?.[0]?.frameRate),
          ),
          frameSeconds(resolved.mediaFile.streamInfo),
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
    @CurrentUser() user: User | undefined,
    @Res() res: Response,
  ) {
    this.sessionRouter.assertFresh(req);
    // Enforce the library ACL on every segment serve (the cached fast path
    // below otherwise serves a revoked-mid-stream session — see hlsSegment).
    await this.streamingService.resolveFile(mediaFileId, user);
    if (!SEGMENT_NAME_RE.test(segment)) {
      throw new BadRequestException(`Invalid audio segment name: ${segment}`);
    }

    const segMatch = segment.match(/seg-(\d+)\.(m4s|ts)/);
    const segIndex = segMatch ? parseInt(segMatch[1], 10) : 0;
    const isInit = segment.startsWith('init');
    // var_stream_map writes audio under `<variantIdx>/`; variant 0 is video,
    // each audio rendition lives under `<audioIndex+1>/` and its init is
    // named `init_<audioIndex+1>.mp4` to match `-hls_fmp4_init_filename`.
    const varStreamPath = `${audioIndex + 1}/${segment}`;

    // Spawn the video session if Shaka raced ahead of playback-info / master.m3u8
    // and there is none registered yet. The audio rendition playlist always rides
    // on a multi-audio video session (master.m3u8 only emits EXT-X-MEDIA when
    // `audioStreams.length > 1`), so we don't need a separate audio-only path —
    // any segment Shaka asks for here is in `<videoSession.cachePath>/<varStreamPath>`.
    let videoSession = this.sessionRouter.resolveSession(mediaFileId, user?.id, req);
    const live = this.sessionRouter.findRequestSession(req, mediaFileId);
    // Throttle playhead signal: an init request carries no position.
    if (!isInit && live) this.liveSessions.trackSegment(live.sessionId, segIndex);
    // A seek can respawn video without this rendition catching up; gated on
    // the file missing so the common case never pays for the resolve+lock.
    const behindOnAudio =
      live?.kind === 'remux' &&
      !!videoSession &&
      !fs.existsSync(path.join(videoSession.cachePath, varStreamPath));
    if (!videoSession || behindOnAudio) {
      const resolved = await this.streamingService.resolveFile(
        mediaFileId,
        req.user as User,
      );
      const ctx = this.sessionContextBuilder.build(req, resolved, mediaFileId);
      this.assertVideoVariant(ctx, req);
      ctx.spawnReason = videoSession ? 'seg-request' : 'seg-race';
      if (live?.kind === 'remux') {
        // Same race, remux playback: spawn the copy session, not a
        // guessed top-rung transcode mislabeled 'remux' into the audio group.
        const spawned = await this.spawnRemuxSession(
          res,
          segment,
          mediaFileId,
          resolved.absolutePath,
          ctx,
          live,
          videoSession ?? null,
          isInit,
          segIndex,
          audioIndex + 1,
        );
        if (!spawned) return;
        videoSession = spawned;
      } else {
        const deviceType = live?.deviceType ?? 'desktop';
        const sv = resolved.mediaFile.streamInfo?.video?.[0];
        const sourceW = sv?.width || 1920;
        const sourceH = sv?.height || 1080;
        const profiles = this.transcodingService.getAvailableProfiles(
          sourceW,
          sourceH,
          deviceType,
        );
        const baseQuality = (profiles[0] ?? PROFILES[PROFILES.length - 1]).name;
        // Audio route can race ahead of the seek-restart's video session
        // being registered: it sees no session, falls into this branch
        // and spawns a brand-new one at the SDR top rung, which then
        // kills the in-flight HDR session via `getOrCreateSession`'s
        // quality-change path. Translate to the HDR rung when the master
        // is publishing the HDR ladder so the spawned session matches.
        const quality = hdrRungName(baseQuality, live?.hdrLadder ?? false);
        // An init anchors at the resume floor (the session playhead); a real
        // segment anchors at the one requested, never a stale heartbeat position.
        const startSeg = this.anchorSegment(live, null, isInit, segIndex);
        videoSession = await this.transcodingService.getOrCreateSession(
          mediaFileId,
          quality,
          resolved.absolutePath,
          startSeg,
          ctx,
          /* skipVerify */ true,
        );
      }
    }

    // Resume: the early companion produces variant inits + seg-0/seg-1 in
    // parallel with main, so it lands first. Use a short timeout — main
    // covers the same files behind it, so wasting 60s on early when it has
    // already exited adds latency for nothing.
    let earlySession = this.sessionRouter.resolveEarlySession(mediaFileId, user?.id, req);
    const wantEarly =
      // The early companion has no 'remux' rung of its own (it picks the
      // top transcode rung); never route a remux audio group through it.
      videoSession.quality !== 'remux' &&
      videoSession.startSegment != null &&
      videoSession.startSegment > 0 &&
      // Only seg-0 .. seg-(EARLY_PROBE_SEGMENTS-1) live in the early session —
      // bound to the same window the video path uses. (Was `< startSegment`,
      // which on a deep resume routed segments the early session never wrote.)
      (isInit || segIndex < EARLY_PROBE_SEGMENTS);
    // (Re)spawn the companion when it is absent or on a different rung, mirroring
    // the video route. The audio rendition rides the video session and is served
    // from the companion's `<audioIndex+1>/` subdir; without this its seg-0/init
    // has no producer when prewarm hasn't landed (or committed to another rung)
    // and the main — anchored at the resume floor — never writes it, so a
    // seg-0-probing client (Shaka, Cast, desktop mpv) gets a 404 on the rendition
    // init. Resolve file/ctx lazily so the common in-window serve adds no work.
    if (wantEarly && (!earlySession || earlySession.quality !== videoSession.quality)) {
      const resolvedEarly = await this.streamingService.resolveFile(
        mediaFileId,
        req.user as User,
      );
      const earlyCtx = this.sessionContextBuilder.build(req, resolvedEarly, mediaFileId);
      earlySession = await this.transcodingService
        .getOrCreateEarlySession(
          mediaFileId,
          videoSession.quality,
          resolvedEarly.absolutePath,
          earlyCtx,
        )
        .catch(() => undefined);
    }
    const useEarly =
      wantEarly &&
      earlySession != null &&
      earlySession.quality === videoSession.quality;

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
      // Mirror the video segment route: a missing file while the producing
      // session is still alive is transient (the rendition init/segment is
      // about to be (re)written — e.g. during a seek respawn), so surface a
      // retryable 503 instead of a hard 404 that players treat as fatal.
      // Only a session whose ffmpeg actually exited is a real 404.
      if (videoSession.process.exitCode === null) {
        this.log.warn(
          `Audio segment 503 (transient): ${segment} (audioIndex=${audioIndex}, mfid=${mediaFileId})`,
        );
        sendTransientUnavailable(res);
        return;
      }
      this.log.warn(
        `Audio segment 404: ${segment} (audioIndex=${audioIndex}, mfid=${mediaFileId}, exitCode=${videoSession.process.exitCode})`,
      );
      res.status(404).send('Segment not found');
      return;
    }

    // 0-byte guard, mirroring the video routes (hlsSegment init/seg paths).
    // var_stream_map writes the rendition init (`<idx+1>/init_<idx+1>.mp4`) with
    // a `creat()`-then-moov-write gap and no `+temp_file` atomic rename for
    // inits, so getSegmentPath can hand back a path the instant the entry
    // appears — while it is still 0 bytes. Passing that straight to
    // segmentPackaging.serve() makes readAndRewriteCmaf return null, which
    // serve() turns into a SILENT 404 (no controller log). A native HLS demuxer
    // (libmpv/ffmpeg) opens the whole master at once and treats a failed
    // alt-audio EXT-X-MAP init as fatal — no retry — so that one 0-byte read
    // crashes the load. Block the init read until the moov lands; on timeout
    // surface a retryable 503 instead of letting serve() emit the fatal 404.
    if (isInit) {
      const ready = await awaitFileNonEmpty(segPath, 5000);
      if (!ready) {
        this.log.warn(
          `Audio segment 503 (0-byte init): ${segment} (audioIndex=${audioIndex}, mfid=${mediaFileId})`,
        );
        sendTransientUnavailable(res);
        return;
      }
    } else {
      const segSize = statSizeOrNull(segPath);
      if (segSize === null || segSize === 0) {
        sendTransientUnavailable(res);
        return;
      }
    }

    // A remux rendition is already assembled onto the served timeline
    // (`RemuxSegmentAssembler`); re-anchoring it here would shift it twice.
    await this.serveFrom(res, segPath, segment, videoSession, videoSession.quality === 'remux');
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
    this.sessionRouter.assertFresh(req);
    const resolved = await this.streamingService.resolveFile(
      mediaFileId,
      req.user as User,
    );
    // Use client-provided duration (from playbackInfo) to skip ffprobe
    const durationHint = firstQueryString(req.query, 'duration');
    const duration =
      (durationHint ? parseFloat(durationHint) : 0) ||
      (await this.resolveDuration(mediaFileId, req, resolved));
    if (!duration) {
      res.status(404).send('Duration unknown — rescan the file first');
      return;
    }

    // No pre-start here: Shaka loads ALL variant playlists in parallel,
    // and pre-starting would create a session at whichever quality arrives first (often 360p).
    // The session is created on first actual segment request (with the correct quality
    // selected by the frontend's ABR lock).
    // Exception: Cast passes startAt for resume position — pre-start for Cast/remux only.
    const live = this.sessionRouter.findRequestSession(req, mediaFileId);
    const startAtRaw = firstQueryString(req.query, 'startAt');
    if (startAtRaw) {
      const existing = this.sessionRouter.resolveSession(mediaFileId, req.user?.id, req);
      if (!existing || existing.process.exitCode !== null) {
        const startAtSec = parseInt(startAtRaw, 10);
        const ctx = this.sessionContextBuilder.build(req, resolved, mediaFileId);
        ctx.spawnReason = 'variant-prespawn';
        if (quality === 'remux') {
          // Copied video is keyframe-cut, so map the resume time to a segment
          // (and seek) via the real keyframe boundaries, not the uniform grid.
          const grid = live?.remuxGrid ?? null;
          const startSegment = grid
            ? gridSegmentIndex(grid.boundaries, startAtSec, ctx.sourceStartPts ?? 0)
            : secondsToSegmentIndex(startAtSec, this.segDur(ctx));
          void this.transcodingService.getOrCreateRemuxSession(
            mediaFileId,
            resolved.absolutePath,
            startSegment,
            ctx,
            grid,
          );
        } else {
          void this.transcodingService.getOrCreateSession(
            mediaFileId,
            quality,
            resolved.absolutePath,
            secondsToSegmentIndex(startAtSec, this.segDur(ctx), ctx.sourceFps),
            ctx,
          );
        }
      }
    }

    const tokenParam = buildTokenParam(req);
    const basePath = `/api/stream/${mediaFileId}/${quality}`;
    // Use the master.m3u8 decision — must match to avoid init filename mismatch.
    const multiAudio = live?.useExtXMedia ?? false;
    const useTs = live?.useTs ?? false;
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

    const segmentUrl = (seg: string) =>
      `${basePath}/seg-${seg}.${segExt}${tokenParam}`;
    const initRef = initName ? `${basePath}/${initName}${tokenParam}` : undefined;

    // Remux copies the source video, so ffmpeg cuts at its (irregular)
    // keyframes — the uniform grid would emit wrong EXTINF durations and drift
    // AVPlayer out of A/V sync. Emit the real keyframe-aligned durations of the
    // grid the playback froze; without one, the uniform grid.
    // Mux-flavour independent: `-c:v copy` cuts on the same source keyframes in
    // MPEG-TS and fMP4 (verified identical to the millisecond).
    const remuxDurations =
      quality === 'remux' ? (live?.remuxGrid?.durations ?? null) : null;
    // A transcoded segment is one forced GOP: its real length keeps fractional-fps
    // streams in sync, frozen so a mid-session re-probe can't move it off-grid.
    const sourceFps =
      live?.sourceFps ??
      parseSourceFps(resolved.mediaFile.streamInfo?.video?.[0]?.frameRate);
    const playlist = remuxDurations
      ? buildVariableVodPlaylist(remuxDurations, segmentUrl, initRef)
      : buildVodPlaylist(
          duration,
          segmentUrl,
          initRef,
          this.fallbackSegDuration(quality === 'remux', sourceFps),
          frameSeconds(resolved.mediaFile.streamInfo),
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
    @CurrentUser() user: User | undefined,
    @Res() res: Response,
  ) {
    if (!VALID_QUALITIES.has(quality)) {
      throw new BadRequestException(`Invalid quality: ${quality}`);
    }
    this.sessionRouter.assertFresh(req);
    // Enforce the library ACL on every segment serve — the cached fast path
    // below otherwise keeps serving a session whose owner lost access
    // mid-stream (only the slow create path checked, not the fast path).
    await this.streamingService.resolveFile(mediaFileId, user);
    if (!SEGMENT_NAME_RE.test(segment)) {
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
    const live = this.sessionRouter.findRequestSession(req, mediaFileId);
    // Truthful for the admin dashboard: a decision made at playback-info can
    // be superseded (ABR switch between the remux rung and a transcoded one).
    if (live) {
      const servedKind: SessionKind = quality === 'remux' ? 'remux' : 'transcode';
      if (live.kind !== servedKind) {
        this.liveSessions.update(live.sessionId, { kind: servedKind });
      }
    }

    // Fast path: if a session already exists, skip the DB query — we only
    // need resolveFile for absolutePath + context when creating a NEW session.
    // Saves ~15-25ms per segment (a 2h file = ~2400 segments = ~40s saved).
    const existing = this.sessionRouter.resolveSession(mediaFileId, req.user?.id, req);

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
      const initFile = this.videoSegName(segment, quality, live?.useExtXMedia ?? false);
      const earlySession = this.sessionRouter.resolveEarlySession(
        mediaFileId,
        req.user?.id,
        req,
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
        await this.serveFrom(res, initPath, segment, src);
        return;
      }
    }

    const segMatch = segment.match(/seg-(\d+)\.(ts|m4s)/);
    const segIndex = segMatch ? parseInt(segMatch[1], 10) : 0;
    // Throttle playhead signal: an init request carries no position.
    if (segMatch && live) this.liveSessions.trackSegment(live.sessionId, segIndex);

    // If a session (running OR completed) already has this segment ON DISK,
    // serve it without any DB query or session management. Completed sessions
    // (exitCode !== null) still have valid segments in cache — don't skip them.
    if (existing && existing.quality === quality) {
      const segName = this.videoSegName(segment, quality, live?.useExtXMedia ?? false);
      const segPath = `${existing.cachePath}/${segName}`;
      if (fs.existsSync(segPath)) {
        // Same 0-byte CDN-poisoning trap as the init handler above: a
        // racing segment write can leave an empty file on disk, and an
        // intermediate cache (Cloudflare with `Cache-Control: max-age`
        // by default) will pin that empty response under the URL.
        // Stat-check and refuse so the CDN never caches the broken
        // version, then mark every segment served from a live transcode
        // session un-cacheable for the same reason.
        const segSize = statSizeOrNull(segPath);
        if (segSize === null || segSize === 0) {
          sendTransientUnavailable(res);
          return;
        }
        existing.lastAccess = Date.now();
        // Remux is cut on source keyframes, off the grid.
        await this.serveFrom(res, segPath, segment, existing, quality === 'remux');
        return;
      }
      // Segment not on disk — fall through to full resolve + getOrCreateSession.
    }

    // Slow path: need to create/restart a session — requires DB lookup.
    const resolved = await this.streamingService.resolveFile(
      mediaFileId,
      req.user as User,
    );

    const ctx = this.sessionContextBuilder.build(req, resolved, mediaFileId);
    this.assertVideoVariant(ctx, req);
    ctx.spawnReason = 'seg-request';

    // Early probe routing: the seg-0/seg-1 init probe a player fires on
    // resume must be served by the bounded early companion, never spawn or
    // relocate the forward-producing main. The floor is the higher of the
    // main's startSegment and the live playhead (secondsToSegmentIndex of the
    // session position) — the playhead survives an in-memory session loss
    // because the recovery playback-info re-seeds it, so a probe arriving
    // after a server restart (no main yet) still routes to early instead of
    // anchoring a fresh main at segment 0. A segment at or past the floor is a
    // genuine seek/forward read the main owns. 10 s timeout safety net falls
    // through to the slow path rather than blocking on a 60 s waitForSegment.
    const isInit = segment.startsWith('init');
    const resumeFloor = this.resumeFloor(live, existing);
    // An init segment is position-independent, so it never anchors the main —
    // otherwise an init request landing right after a restart (before recovery
    // re-seeds the live playhead) would spawn a fresh main at segment 0. A
    // seg-0/seg-1 probe routes to early only while the playhead sits past the
    // early window (a resume); at the start it is the real first read the main
    // owns.
    const isEarlyProbe =
      quality !== 'remux' &&
      // Only engines that fetch seg-0 on a load-then-seek (Shaka / Cast) use
      // the early companion. Native players seek straight to the main's
      // segment and only fetch the position-independent init, so routing that
      // init here would spawn a companion they never read — keep them on main.
      (live?.probesSegZero ?? true) &&
      (isInit ||
        (resumeFloor > EARLY_PROBE_SEGMENTS &&
          segIndex < EARLY_PROBE_SEGMENTS));
    if (isEarlyProbe) {
      let earlySession = this.sessionRouter.resolveEarlySession(
        mediaFileId,
        req.user?.id,
        req,
      );
      // (Re)spawn the early companion at the requested quality when it is
      // absent or on a different rung — prewarm picks a rung from the saved
      // preference and the player may commit to another, leaving a stale
      // early that the quality gate below would skip.
      if (!earlySession || earlySession.quality !== quality) {
        earlySession = await this.transcodingService
          .getOrCreateEarlySession(
            mediaFileId,
            quality,
            resolved.absolutePath,
            ctx,
          )
          .catch(() => undefined);
      }
      if (earlySession && earlySession.quality === quality) {
        const segName = this.videoSegName(segment, quality, live?.useExtXMedia ?? false);
        const segPath = await this.transcodingService.getSegmentPath(
          earlySession,
          segName,
          10_000,
        );
        if (segPath) {
          const earlySize = statSizeOrNull(segPath);
          if (earlySize === null || earlySize === 0) {
            sendTransientUnavailable(res);
            return;
          }
          await this.serveFrom(res, segPath, segment, earlySession);
          return;
        }
        // Early failed/timeout — log and fall through to slow path
        this.log.error(
          `[early] no seg-${segIndex} after 10s for mfid=${mediaFileId} — fallback`,
        );
      }
    }

    // Remux: anchor + seek on the keyframe boundaries the playback froze so a resume
    // / forward seek lands on the right content and the post-seek playlist stays
    // aligned. Non-remux keeps the uniform grid (force_key_frames makes it true).
    let session: TranscodeSession;
    if (quality === 'remux') {
      const spawned = await this.spawnRemuxSession(
        res,
        segment,
        mediaFileId,
        resolved.absolutePath,
        ctx,
        live,
        existing,
        isInit,
        segIndex,
      );
      if (!spawned) return;
      session = spawned;
    } else {
      const anchorSeg = this.anchorSegment(live, existing, isInit, segIndex);
      session = await this.transcodingService.getOrCreateSession(
        mediaFileId,
        quality,
        resolved.absolutePath,
        anchorSeg,
        ctx,
      );
    }

    const segName = this.videoSegName(segment, quality, live?.useExtXMedia ?? false);
    const segPath = await this.transcodingService.getSegmentPath(
      session,
      segName,
    );
    if (!segPath) {
      // Still producing → the segment arrives on a later tick; surface as
      // transient so players retry. Hard 404 only once the run is over.
      if (this.transcodingService.isProducing(session)) {
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

    const finalSize = statSizeOrNull(segPath);
    if (finalSize === null || finalSize === 0) {
      sendTransientUnavailable(res);
      return;
    }
    // Remux is cut on source keyframes, off the grid; the early-probe
    // paths never run for remux (gated on quality !== 'remux').
    await this.serveFrom(res, segPath, segment, session, quality === 'remux');
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

    // Keep the LiveSession alive while the Range chunks roll in — the
    // heartbeat endpoint only fires on HLS/transcode paths, so without this
    // every direct-play would get GC'd 30 s after playback-info and disappear
    // from the dashboard. DirectPlay presence on the admin dashboard is the
    // LiveSession itself (kind='directplay'), minted at playback-info.
    const sid = firstQueryString(req.query, 'sid');
    if (sid) {
      this.liveSessions.heartbeat(sid, {});
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

    // Browser "save the original file" path: force an attachment download with
    // the source container's own name. Only embedded streams travel inside the
    // container — sidecar subtitle files live next to it and aren't included.
    if (firstQueryString(req.query, 'download')) {
      res.attachment(path.basename(resolved.relativePath));
    }

    if (!range) {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', fileSize);
      res.setHeader('Accept-Ranges', 'bytes');
      // pipe() does not forward source errors, so a read failure (EIO/ESTALE
      // on a network mount, a file swapped mid-stream) would emit an
      // unhandled 'error' and crash the process, killing every active
      // playback. Close this one response instead.
      const fullStream = fs.createReadStream(absolutePath);
      fullStream.on('error', (err) => {
        this.log.error(
          `direct-play read error (mediaFileId=${mediaFileId}): ${err}`,
        );
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
      });
      fullStream.pipe(res);
      return;
    }

    const parsed = parseByteRange(range, fileSize);
    if (!parsed) {
      // RFC 7233 §4.4 — unsatisfiable / malformed range.
      res.status(416);
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      res.end();
      return;
    }
    const { start, end } = parsed;
    const chunkSize = end - start + 1;

    res.status(206);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', chunkSize);

    const rangeStream = fs.createReadStream(absolutePath, { start, end });
    rangeStream.on('error', (err) => {
      this.log.error(
        `direct-play read error (mediaFileId=${mediaFileId}): ${err}`,
      );
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    rangeStream.pipe(res);
  }
}
