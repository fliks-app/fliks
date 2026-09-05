import {
  Controller,
  Delete,
  Get,
  Logger,
  Post,
  Body,
  Param,
  ParseIntPipe,
  Query,
  Req,
  Res,
  Sse,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { Library } from '../libraries/entities/library.entity';
import { PluginPackage } from '../plugins/entities/plugin-package.entity';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { SessionTokenGuard } from '../auth/guards/session-token.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { BackupService } from './backup.service';
import { LogBufferService } from './log-buffer.service';
import { EventsService } from './events.service';
import { ActivityRegistryService, type ActivityRow } from './activity-registry.service';
import { UpdateCheckService, type UpdateStatus } from './update-check.service';
import { Observable } from 'rxjs';
import {
  type HwAccelType,
  type TranscodeSession,
  TranscodingService,
  TranscodeCacheService,
  getLadderForDevice,
  getHdrLadderForDevice,
  parseBitrateToBps,
} from '../streaming/transcoding';
import {
  type LiveSessionSnapshot,
  LiveSessionRegistry,
} from '../streaming/live-session.service';
import { StreamLifetime } from '../streaming/lifetime-constants';
import { PlaybackService } from '../streaming/playback.service';
import { MediaFile } from '../media/entities/media-file.entity';
import { Episode } from '../media/entities/episode.entity';
import { FliksRequest } from '../requests/entities/request.entity';
import { RequestStatus } from '../../common/enums';
import { bucketResolutionLabel } from '../../common/utils/resolution.util';

const APP_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export interface ActiveStreamDto {
  sessionId: string;
  userId: number | null;
  username: string | null;
  mediaId: number;
  mediaFileId: number;
  mediaTitle: string;
  mediaType: string;
  episodeId: number | null;
  episodeLabel: string | null;
  posterUrl: string | null;
  mode: 'transcode' | 'remux' | 'directplay';
  quality: string;
  hwAccel: string;
  device: string | null;
  /** Real host OS name+version ("macOS 26") from the client; overrides the
   *  frozen-UA OS in the device label. */
  systemName: string | null;
  /** Fliks client build version ("1.15.2"); only non-web clients (native app /
   *  TV / desktop) report it, so it's null for browser sessions. */
  appVersion: string | null;
  startedAt: string;
  lastActivity: string;
  // Progress
  positionSeconds: number;
  durationSeconds: number;
  // Stream info
  container: string | null;
  videoCodec: string | null;
  videoResolution: string | null;
  videoBitrate: number | null;
  audioCodec: string | null;
  audioChannels: string | null;
  audioLanguage: string | null;
  outputContainer: string | null;
  outputBitrate: number | null;
  /** `null` when audio is direct-played (no transcode). For transcoded
   *  sessions, the actual codec ffmpeg emits — caller renders the display
   *  string from these raw values. */
  audioOutputCodec: string | null;
  audioOutputBitrateBps: number | null;
  /** Computed audio pipeline state — `'direct'` = no Fliks involvement
   *  (DirectPlay), `'copy'` = container changed but audio bitstream
   *  preserved (remux + supported codec), `'transcode'` = ffmpeg re-encoded
   *  to a different codec. Frontend renders straight from this value. */
  audioMode: 'direct' | 'copy' | 'transcode';
  /** Transcode buffer progress (0-100), null for direct play */
  transcodePercent: number | null;
  /** HDR served untouched to a client that tone-maps it to its SDR display. */
  clientTonemap: boolean;
  /** Reasons why transcoding is needed, split by category */
  videoReasons: string[];
  audioReasons: string[];
  containerReasons: string[];
}

export interface ServiceStatus {
  name: string;
  ok: boolean;
  message?: string;
}

export interface HealthReport {
  version: string;
  uptimeSeconds: number;
  database: ServiceStatus;
  /** Core reports only how many plugins are installed. A capability's own
   *  reachability belongs on that capability's page, which its plugin owns. */
  installedPlugins: number;
  /** Enabled, not necessarily reachable — same scope limit as `installedPlugins`. */
  runningPlugins: number;
  restartSupervisor: string | null;
}

function detectRestartSupervisor(): string | null {
  if (process.env.FLIKS_SUPERVISED) return 'supervisor';
  if (process.env.pm_id) return 'pm2';
  if (process.env.INVOCATION_ID) return 'systemd';
  if (fs.existsSync('/.dockerenv')) return 'docker';
  return null;
}

export interface DiskSpaceEntry {
  path: string;
  label: string | null;
  freeSpace: number;
  totalSpace: number;
}

export interface StatsReport {
  movies: number;
  series: number;
  pendingRequests: number;
  diskSpace: DiskSpaceEntry[];
}

/** Map a LiveSession `audioPlan` to the dashboard's audio output fields.
 *  With a plan, the plan is authoritative (copy or transcode); without one,
 *  remux copies the bitstream and every other mode is a straight direct play. */
function deriveAudioOutput(
  audioPlan: LiveSessionSnapshot['audioPlan'],
  mode: 'transcode' | 'remux' | 'directplay',
): {
  audioMode: 'direct' | 'copy' | 'transcode';
  audioOutputCodec: string | null;
  audioOutputBitrateBps: number | null;
} {
  // DirectPlay serves the source file untouched — the audio is direct, not a
  // Fliks copy/transcode, even though the session still carries a copy plan.
  if (mode === 'directplay') {
    return { audioMode: 'direct', audioOutputCodec: null, audioOutputBitrateBps: null };
  }
  if (audioPlan) {
    return {
      audioMode: audioPlan.mode,
      audioOutputCodec: audioPlan.codec,
      audioOutputBitrateBps:
        audioPlan.mode === 'transcode' ? audioPlan.bitrateBps : null,
    };
  }
  return {
    audioMode: mode === 'remux' ? 'copy' : 'direct',
    audioOutputCodec: null,
    audioOutputBitrateBps: null,
  };
}

@Controller('system')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class SystemController {
  private readonly logger = new Logger(SystemController.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Library)
    private readonly libraryRepo: Repository<Library>,
    @InjectRepository(PluginPackage)
    private readonly pluginPackageRepo: Repository<PluginPackage>,
    private readonly backup: BackupService,
    private readonly logBuffer: LogBufferService,
    private readonly eventsService: EventsService,
    private readonly activityRegistry: ActivityRegistryService,
    private readonly transcodingService: TranscodingService,
    private readonly transcodeCache: TranscodeCacheService,
    private readonly liveSessions: LiveSessionRegistry,
    private readonly playbackService: PlaybackService,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(FliksRequest)
    private readonly requestRepo: Repository<FliksRequest>,
    private readonly updateCheck: UpdateCheckService,
  ) {}

  // Authentication is the whole gate: the stream only ever emits what this user id is
  // already a recipient of, and `PoliciesGuard` denies a handler that declares nothing.
  //
  // The device identity rides the query string because `EventSource` cannot set
  // headers, and because arriving with the connection removes any
  // connect-then-announce race and re-announces free on every reconnect.
  // A client that sends no `device` simply never becomes a remote target.
  @Sse('events')
  @UseGuards(SessionTokenGuard)
  @CheckPolicies(() => true)
  events(
    @CurrentUser() user: User,
    @Req() req: Request,
    @Query('device') device?: string,
    @Query('ff') ff?: string,
    @Query('tvPlatform') tvPlatform?: string,
    @Query('name') name?: string,
  ): Observable<MessageEvent> {
    return this.eventsService.getStream(user.id, {
      targetId: device ?? null,
      formFactor: ff ?? null,
      tvPlatform: tvPlatform ?? null,
      deviceName: name ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  }

  @Get('health')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async health(): Promise<HealthReport> {
    return {
      version: APP_VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
      database: await this.checkDatabase(),
      installedPlugins: await this.pluginPackageRepo.count(),
      runningPlugins: await this.pluginPackageRepo.count({ where: { enabled: true } }),
      restartSupervisor: detectRestartSupervisor(),
    };
  }

  @Post('restart')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  restart(): { ok: true; supervisor: string } {
    const supervisor = detectRestartSupervisor();
    if (!supervisor) {
      throw new BadRequestException('No process supervisor detected');
    }
    this.logger.warn(`Restart requested (supervisor: ${supervisor})`);
    // In a container PID 1 must exit, else the `npm run` wrapper outlives us.
    const target = supervisor === 'docker' ? 1 : process.pid;
    process.exitCode = 1;
    setTimeout(() => process.kill(target, 'SIGTERM'), 300);
    return { ok: true, supervisor };
  }

  @Get('update')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async update(): Promise<UpdateStatus> {
    return this.updateCheck.getStatus();
  }

  /** Running + queued work, running first: backs the System page's Activity
   *  table. The client refetches this on an `activity.changed` ping rather than
   *  the registry pushing rows over SSE itself. */
  @Get('activity')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  activity(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): { data: ActivityRow[]; total: number; dropped: number } {
    const parsedPage = page ? Number.parseInt(page, 10) : 1;
    const parsedLimit = limit ? Number.parseInt(limit, 10) : 25;
    return this.activityRegistry.list(
      Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1,
      Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 25,
    );
  }

  private async checkDatabase(): Promise<ServiceStatus> {
    try {
      await this.dataSource.query('SELECT 1');
      return { name: 'PostgreSQL', ok: true };
    } catch (e) {
      return { name: 'PostgreSQL', ok: false, message: (e as Error).message };
    }
  }

  @Get('stats')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async stats(): Promise<StatsReport> {
    const [[moviesRow], [seriesRow], pendingRequests, libraries] =
      await Promise.all([
        this.dataSource.query(
          `SELECT COUNT(*)::int AS count FROM media WHERE type = 'movie'`,
        ),
        this.dataSource.query(
          `SELECT COUNT(*)::int AS count FROM media WHERE type = 'series'`,
        ),
        this.requestRepo.count({ where: { status: RequestStatus.PENDING } }),
        this.libraryRepo.find({ order: { name: 'ASC' } }),
      ]);

    const diskSpace: DiskSpaceEntry[] = libraries
      .filter((lib) => !!lib.path)
      .map((lib) => {
        try {
          const stat = fs.statfsSync(lib.path!);
          return {
            path: lib.path!,
            label: lib.label ?? lib.name,
            freeSpace: stat.bfree * stat.bsize,
            totalSpace: stat.blocks * stat.bsize,
          };
        } catch {
          return {
            path: lib.path!,
            label: lib.label ?? lib.name,
            freeSpace: -1,
            totalSpace: -1,
          };
        }
      });

    return {
      movies: moviesRow.count,
      series: seriesRow.count,
      pendingRequests,
      diskSpace,
    };
  }

  @Post('backup')
  @CheckPolicies((ability) => ability.can(Action.Create, 'Settings'))
  createBackup() {
    return this.backup.createBackup();
  }

  @Get('backups')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  listBackups() {
    return this.backup.listBackups();
  }

  @Post('restore')
  @CheckPolicies((ability) => ability.can(Action.Create, 'Settings'))
  restore(@Body() body: { filename: string }) {
    return this.backup.restore(body.filename);
  }

  @Get('backups/:name')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  downloadBackup(@Param('name') name: string, @Res() res: Response) {
    const filePath = this.backup.getBackupPath(name);
    res.download(filePath, name);
  }

  @Get('logs')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  getLogs(
    @Query('level') level?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.logBuffer.getEntries({
      level: level || undefined,
      q: q || undefined,
      limit: limit ? parseInt(limit, 10) : 200,
    });
  }

  // ---------------------------------------------------------------------------
  // Active streams (video activity dashboard)
  // ---------------------------------------------------------------------------

  @Get('streams')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async activeStreams(): Promise<ActiveStreamDto[]> {
    const hwAccel = this.transcodingService.getDetectedHwAccel();
    const streams: ActiveStreamDto[] = [];

    // LiveSessionRegistry is the single source of truth for "who is
    // currently watching". Each playback gets its own sid, so two
    // devices on the same (user, file) coexist as two distinct
    // entries — no clobber, no dedup destroying multi-device.
    // Show only genuinely-live sessions. `list()` returns every entry (the
    // bulk DELETE handler relies on that), so a client that died still shows
    // here until the next GC sweep. Filter to the same TTL the registry GCs
    // on so a dead session drops off the dashboard at once.
    const liveTtlMs = StreamLifetime.liveSessionTtlMs();
    const live = this.liveSessions
      .list()
      .filter((s) => s.lastBeat.getTime() > Date.now() - liveTtlMs);
    const transcodeSessions = this.transcodingService.getActiveSessions();
    const findTranscodeSession = (
      userId: number | null,
      mediaFileId: number,
      profileHash: string | null,
    ): TranscodeSession | undefined => {
      if (profileHash == null) return undefined;
      return transcodeSessions.find(
        (ts) =>
          ts.userId === userId &&
          ts.mediaFileId === mediaFileId &&
          ts.baseProfileHash === profileHash,
      );
    };

    // Collect lookups before the per-session loop so we batch DB hits.
    // DirectPlay is a LiveSession (kind='directplay') like any other mode, so
    // the registry is the only source — no separate tracker to merge in.
    const mediaFileIds = [...new Set(live.map((s) => s.mediaFileId))];
    const mediaFiles = mediaFileIds.length
      ? await this.mediaFileRepo.findByIds(mediaFileIds)
      : [];
    const mediaFileMap = new Map(mediaFiles.map((mf) => [mf.id, mf]));

    type StreamWorkItem = {
      sessionId: string;
      userId: number | null;
      username: string | null;
      mediaFileId: number;
      mediaTitle: string;
      mediaType: string;
      posterUrl: string | null;
      mode: 'transcode' | 'remux' | 'directplay';
      quality: string;
      hwAccelVal: string;
      startedAt: string;
      lastActivity: string;
      deviceLabel: string | null;
      systemName: string | null;
      appVersion: string | null;
      transcodeSession: TranscodeSession | undefined;
      clientTonemap: boolean;
      audioPlan: LiveSessionSnapshot['audioPlan'];
      position: number;
      episodeId: number | null;
    };

    const work: StreamWorkItem[] = [];

    for (const session of live) {
      const ts = findTranscodeSession(
        session.userId,
        session.mediaFileId,
        session.profileHash,
      );
      const mode: 'transcode' | 'remux' | 'directplay' =
        session.kind === 'directplay'
          ? 'directplay'
          : session.kind === 'remux'
            ? 'remux'
            : 'transcode';
      const quality =
        mode === 'directplay'
          ? 'original'
          : (ts?.quality ?? session.quality ?? 'original');
      const hwAccelVal =
        mode === 'directplay' || mode === 'remux'
          ? 'none'
          : (ts?.actualHwAccel ?? hwAccel);
      work.push({
        sessionId: session.sessionId,
        userId: session.userId,
        username: session.username,
        mediaFileId: session.mediaFileId,
        mediaTitle: session.mediaTitle ?? '',
        mediaType: session.mediaType ?? '',
        posterUrl: session.posterUrl,
        mode,
        quality,
        hwAccelVal,
        startedAt: session.startedAt.toISOString(),
        lastActivity: session.lastBeat.toISOString(),
        deviceLabel: session.deviceLabel,
        systemName: session.systemName,
        appVersion: session.appVersion,
        transcodeSession: ts,
        clientTonemap: session.clientTonemap,
        audioPlan: session.audioPlan,
        // The LiveSession keeps the playhead fresh on every heartbeat — read
        // it straight from memory instead of a per-row playback_states query.
        position: session.position,
        episodeId: mediaFileMap.get(session.mediaFileId)?.episodeId ?? null,
      });
    }

    for (const s of work) {
      const mf = mediaFileMap.get(s.mediaFileId);
      const si = mf?.streamInfo;
      const v = si?.video?.[0];
      const a = si?.audio?.[0];

      // Position comes from the in-memory LiveSession (fresher than the
      // debounced playback_states row); duration from the probed streamInfo.
      const positionSeconds = s.position;
      const durationSeconds = si?.durationSeconds ?? 0;
      const episodeId = s.episodeId;

      // Output decisions: the LiveSession holds the authoritative
      // `audioPlan`; mode/codec/bitrate read directly.
      let outputContainer: string | null = null;
      let outputBitrate: number | null = null;
      const audio = deriveAudioOutput(s.audioPlan, s.mode);
      const audioMode = audio.audioMode;
      const audioOutputCodec = audio.audioOutputCodec;
      const audioOutputBitrateBps = audio.audioOutputBitrateBps;

      if (s.mode === 'transcode') {
        outputContainer = 'HLS';
        const rung = [
          ...getLadderForDevice(undefined),
          ...getHdrLadderForDevice(undefined),
        ].find((p) => p.name === s.quality);
        outputBitrate = rung ? parseBitrateToBps(rung.videoBitrate) : null;
      } else if (s.mode === 'remux') {
        outputContainer = 'HLS';
        outputBitrate = (v?.bitRate ?? 0) + (a?.bitRate ?? 0) || null;
      }

      const sourceResLabel =
        v?.width && v?.height
          ? (bucketResolutionLabel(v.width, v.height) ??
            `${v.width}x${v.height}`)
          : null;
      // For transcode sessions, show the target quality, not the source resolution
      const resLabel =
        s.mode === 'transcode' && s.quality !== 'original'
          ? s.quality
          : sourceResLabel;

      streams.push({
        sessionId: s.sessionId,
        userId: s.userId,
        username: s.username,
        mediaId: mf?.mediaId ?? 0,
        mediaFileId: s.mediaFileId,
        mediaTitle: s.mediaTitle,
        mediaType: s.mediaType,
        episodeId,
        episodeLabel: null as string | null, // resolved below
        posterUrl: s.posterUrl,
        mode: s.mode,
        quality: s.quality,
        hwAccel: s.hwAccelVal,
        device: s.deviceLabel,
        systemName: s.systemName,
        appVersion: s.appVersion,
        startedAt: s.startedAt,
        lastActivity: s.lastActivity,
        positionSeconds,
        durationSeconds,
        container: mf?.relativePath
          ? path.extname(mf.relativePath).replace(/^\./, '') || null
          : null,
        videoCodec: v?.codec?.toUpperCase() ?? null,
        videoResolution: resLabel,
        videoBitrate: v?.bitRate ?? null,
        audioCodec: a?.codec?.toUpperCase() ?? null,
        audioChannels:
          a?.channelLayout ?? (a?.channels ? `${a.channels}ch` : null),
        audioLanguage: a?.language ?? null,
        outputContainer,
        outputBitrate,
        audioOutputCodec,
        audioOutputBitrateBps,
        audioMode,
        transcodePercent: null as number | null, // filled below for transcode sessions
        clientTonemap: s.clientTonemap,
        videoReasons: [] as string[],
        audioReasons: [] as string[],
        containerReasons: [] as string[],
      });
    }

    // Resolve episode labels
    const uniqueEpIds = [
      ...new Set(
        streams.map((s) => s.episodeId).filter((id): id is number => !!id),
      ),
    ];
    if (uniqueEpIds.length) {
      const episodes = await this.episodeRepo.find({
        where: uniqueEpIds.map((id) => ({ id })),
        relations: ['season'],
      });
      const epMap = new Map(episodes.map((e) => [e.id, e]));
      for (const stream of streams) {
        if (!stream.episodeId) continue;
        const ep = epMap.get(stream.episodeId);
        if (ep) {
          const label = `S${ep.season?.seasonNumber ?? '?'}:E${ep.episodeNumber}`;
          stream.episodeLabel = ep.title ? `${label} - ${ep.title}` : label;
        }
      }
    }

    // Fill transcode progress / reasons for sessions that have a
    // matching ffmpeg session.
    for (let i = 0; i < streams.length; i++) {
      const stream = streams[i];
      const ts = work[i].transcodeSession;
      if (!ts || stream.mode === 'directplay') continue;
      if (stream.durationSeconds > 0) {
        stream.transcodePercent =
          await this.transcodingService.getTranscodePercent(
            ts,
            stream.durationSeconds,
          );
      }
      // Deduplicate by flag (reasons can be pushed from multiple code paths)
      const seen = new Set<string>();
      const reasons = (ts.transcodeReasons ?? []).filter((r) => {
        if (seen.has(r.flag)) return false;
        seen.add(r.flag);
        return true;
      });
      stream.videoReasons = reasons
        .filter((r) => r.flag.startsWith('Video'))
        .map((r) => r.message);
      stream.audioReasons = reasons
        .filter((r) => r.flag.startsWith('Audio'))
        .map((r) => r.message);
      stream.containerReasons = reasons
        .filter((r) => r.flag.startsWith('Container'))
        .map((r) => r.message);
    }

    return streams;
  }

  /**
   * Resolve a dashboard `sessionId` to the (user, mediaFile) pair the
   * command targets. The dashboard hands us two flavours of id:
   *   - A `LiveSession.sessionId` UUID — the canonical id (every mode,
   *     DirectPlay included, is a LiveSession).
   *   - A `TranscodeSession.id` hash — left in for completeness; the
   *     dashboard hasn't emitted these in a while but a stale client
   *     tab could still send one.
   * Returns null when neither lookup produces a (user, file) pair the
   * command can act on.
   */
  private resolveStreamCommandTarget(sessionId: string): {
    userId: number;
    mediaFileId: number;
    profileHash: string | null;
    isDirectPlay: boolean;
  } | null {
    const live = this.liveSessions.get(sessionId);
    if (live && live.userId != null) {
      return {
        userId: live.userId,
        mediaFileId: live.mediaFileId,
        profileHash: live.profileHash ?? null,
        isDirectPlay: live.kind === 'directplay',
      };
    }
    const transcode = this.transcodingService
      .getActiveSessions()
      .find((s) => s.id === sessionId);
    if (transcode && transcode.userId != null) {
      return {
        userId: transcode.userId,
        mediaFileId: transcode.mediaFileId,
        profileHash: transcode.baseProfileHash ?? null,
        isDirectPlay: false,
      };
    }
    return null;
  }

  /** Current on-disk transcode cache footprint, for the admin UI. */
  @Get('transcode-cache')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  transcodeCacheStats(): Promise<{ entries: number; bytes: number }> {
    return this.transcodeCache.diskUsage();
  }

  /**
   * Purge the entire on-disk transcode cache. Lets operators free disk
   * in one click; in-progress playbacks simply retranscode on the next
   * segment. TTL + LRU still handle this automatically — this is the
   * manual escape hatch.
   */
  @Delete('transcode-cache')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  async purgeAllTranscodeCache(): Promise<{
    ok: true;
    entries: number;
    bytes: number;
  }> {
    const freed = await this.transcodeCache.purge();
    return { ok: true, ...freed };
  }

  /**
   * Purge the on-disk transcode cache for one media file, optionally
   * scoped to a single user via `?userId=`. Same escape hatch as the
   * cache-wide purge above, narrowed to force a clean retranscode of a
   * single title.
   */
  @Delete('transcode-cache/:mediaFileId')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  async purgeTranscodeCache(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Query('userId') userId?: string,
  ): Promise<{ ok: true; entries: number; bytes: number }> {
    const scopedUser = userId ? Number.parseInt(userId, 10) : undefined;
    const freed = await this.transcodeCache.purge(
      mediaFileId,
      Number.isFinite(scopedUser) ? scopedUser : undefined,
    );
    return { ok: true, ...freed };
  }

  @Post('streams/:sessionId/command')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  sendPlayerCommand(
    @Param('sessionId') sessionId: string,
    @Body() body: { action: 'pause' | 'play' | 'stop' | 'message'; message?: string },
  ) {
    const target = this.resolveStreamCommandTarget(sessionId);
    if (!target) {
      throw new BadRequestException('Session not found');
    }

    const live = this.liveSessions.get(sessionId);
    const cmdEvent = {
      type: 'player.command' as const,
      sessionId,
      mediaFileId: target.mediaFileId,
      userId: target.userId,
      action: body.action,
      message: body.message,
    };
    const sseConnectionId = live?.sseConnectionId;
    if (sseConnectionId && this.eventsService.hasConnection(sseConnectionId)) {
      this.eventsService.emitToConnection(sseConnectionId, cmdEvent);
    } else {
      // Clients without a bound SSE connection: every tab/device for
      // this user receives the command — they must filter on sessionId.
      this.eventsService.emitToUser(target.userId, cmdEvent);
    }

    if (body.action === 'stop') {
      this.liveSessions.stop(sessionId);
      if (!target.isDirectPlay && target.profileHash) {
        const remaining = this.liveSessions.listForJob(
          target.userId,
          target.mediaFileId,
          target.profileHash,
        );
        if (remaining.length === 0) {
          // Admin stop is a force-kill: reap every ffmpeg variant of the job
          // (main / early / remux / per-audio), not just the main one — the
          // companions would otherwise idle on until the reaper sweeps them.
          this.transcodingService.killSessionsForJob(
            target.mediaFileId,
            target.userId,
            target.profileHash,
          );
        }
      }
    }

    return { ok: true };
  }
}
