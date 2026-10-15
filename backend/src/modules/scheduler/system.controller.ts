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
  Res,
  UseGuards,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import type { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { Library } from '../libraries/entities/library.entity';
import { PluginPackage } from '../plugins/entities/plugin-package.entity';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { BackupService } from './backup.service';
import { LogBufferService } from './log-buffer.service';
import { EventsService } from './events.service';
import { LiveTvSessionService } from '../livetv/services/livetv-session.service';
import { UpdateCheckService, type UpdateStatus } from './update-check.service';
import { HostHardwareService } from '../streaming/host-hardware.service';
import { servedRung } from '../streaming/served-rung';
import {
  type LiveSessionSnapshot,
  type SessionKind,
  LiveSessionRegistry,
} from '../streaming/live-session.service';
import { StreamLifetime } from '../streaming/lifetime-constants';
import { EngineService, type SessionSnapshot } from '../engine/engine.service';
import { QoeService, type QoeLiveSummary } from '../qoe/qoe.service';
import { MediaFile } from '../media/entities/media-file.entity';
import { Episode } from '../media/entities/episode.entity';
import { FliksRequest } from '../requests/entities/request.entity';
import { RequestStatus } from '../../common/enums';
import { bucketResolutionLabel } from '../../common/utils/resolution.util';
import { CURRENT_FLIKS_VERSION } from '../plugins/plugin-version';

const APP_VERSION = CURRENT_FLIKS_VERSION;

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
  mode: SessionKind;
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
  /** Playback quality so far; null when QoE is off or the session is not tracked. */
  qoe: QoeLiveSummary | null;
  /** The engine's state: `off` is not configured, `down` is a configured engine that does not answer. */
  engineStatus: 'off' | 'up' | 'down';
  /** The ffmpeg run behind the session as the engine reports it (`actualHw` is the backend in use,
   *  `none` after a CPU fallback); null on direct play and live TV. */
  job: SessionSnapshot['job'] | null;
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
 *  remux copies the bitstream and every other mode is a straight direct play.
 *  A re-encode's bitrate is the served rung's, unknown off the ladder. */
function deriveAudioOutput(
  audioPlan: LiveSessionSnapshot['audioPlan'],
  mode: SessionKind,
  rungAudioBps: number | null,
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
        audioPlan.mode === 'copy'
          ? (audioPlan.bitrateBps ?? null)
          : rungAudioBps,
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
    private readonly hardware: HostHardwareService,
    private readonly liveSessions: LiveSessionRegistry,
    private readonly liveTvSessions: LiveTvSessionService,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    @InjectRepository(FliksRequest)
    private readonly requestRepo: Repository<FliksRequest>,
    private readonly updateCheck: UpdateCheckService,
    private readonly qoe: QoeService,
    @Optional() private readonly engine?: EngineService,
  ) {}

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

  /** Any signed-in client: the desktop app compares its own update against it. */
  @Get('version')
  @CheckPolicies(() => true)
  version(): { version: string } {
    return { version: APP_VERSION };
  }

  @Get('update')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async update(): Promise<UpdateStatus> {
    return this.updateCheck.getStatus();
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

  @Delete('backups/:name')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  deleteBackup(@Param('name') name: string): { ok: true } {
    this.backup.deleteBackup(name);
    return { ok: true };
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
    const hwAccel = this.hardware.hwAccel;
    const streams: ActiveStreamDto[] = [];

    // LiveSessionRegistry is the single source of truth for "who is
    // currently watching". Each playback gets its own sid, so two
    // devices on the same (user, file) coexist as two distinct
    // entries — no clobber, no dedup destroying multi-device.
    // Show only genuinely-live sessions. `list()` returns every entry (the
    // bulk DELETE handler relies on that), so a client that died still shows
    // here until the next GC sweep. Filter to the same TTL the registry GCs
    // on so a dead session drops off the dashboard at once.
    // The engine, when it runs playback, is the authority on what is live and how it runs.
    const engineSessions = await this.engineSessions();
    const liveTtlMs = StreamLifetime.liveSessionTtlMs();
    const live = this.liveSessions
      .list()
      .filter((s) =>
        engineSessions
          ? engineSessions.has(s.sessionId)
          : s.lastBeat.getTime() > Date.now() - liveTtlMs,
      );
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
      mode: SessionKind;
      quality: string;
      hwAccelVal: string;
      startedAt: string;
      lastActivity: string;
      deviceLabel: string | null;
      systemName: string | null;
      appVersion: string | null;
      engine: SessionSnapshot | undefined;
      clientTonemap: boolean;
      audioPlan: LiveSessionSnapshot['audioPlan'];
      hdrLadder: boolean;
      bitrateByQuality: LiveSessionSnapshot['bitrateByQuality'];
      position: number;
      episodeId: number | null;
    };

    const work: StreamWorkItem[] = [];

    for (const session of live) {
      const eng = engineSessions?.get(session.sessionId);
      const quality =
        session.kind === 'directplay'
          ? 'original'
          : (eng?.quality ?? session.quality ?? 'original');
      const hwAccelVal =
        session.kind === 'directplay' || session.kind === 'remux'
          ? 'none'
          : (eng?.job?.actualHw ?? hwAccel);
      work.push({
        sessionId: session.sessionId,
        userId: session.userId,
        username: session.username,
        mediaFileId: session.mediaFileId,
        mediaTitle: session.mediaTitle ?? '',
        mediaType: session.mediaType ?? '',
        posterUrl: session.posterUrl,
        mode: session.kind,
        quality,
        hwAccelVal,
        startedAt: session.startedAt.toISOString(),
        lastActivity: (eng ? new Date(eng.lastBeatMs) : session.lastBeat).toISOString(),
        deviceLabel: session.deviceLabel,
        systemName: session.systemName,
        appVersion: session.appVersion,
        engine: eng,
        clientTonemap: session.clientTonemap,
        audioPlan: session.audioPlan,
        hdrLadder: session.hdrLadder,
        bitrateByQuality: session.bitrateByQuality,
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
      const rung = servedRung({ ...s, kind: s.mode });
      const audio = deriveAudioOutput(
        s.audioPlan,
        s.mode,
        rung?.audioBitrateBps ?? null,
      );
      const audioMode = audio.audioMode;
      const audioOutputCodec = audio.audioOutputCodec;
      const audioOutputBitrateBps = audio.audioOutputBitrateBps;

      if (s.mode === 'transcode') {
        outputContainer = 'HLS';
        outputBitrate = rung?.videoBitrateBps ?? null;
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
        qoe: this.qoe.liveSummary(s.sessionId),
        engineStatus: this.engine?.status ?? 'off',
        job: s.engine?.job ?? null,
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

    // Progress and reasons of the engine's run behind each session.
    for (let i = 0; i < streams.length; i++) {
      const stream = streams[i];
      const eng = work[i].engine;
      if (!eng || stream.mode === 'directplay') continue;
      stream.transcodePercent = eng.job?.transcodePercent ?? null;
      const flags = (prefix: string) =>
        eng.decision.response.transcodeReasons
          .filter((r) => r.flag.startsWith(prefix))
          .map((r) => r.message);
      stream.videoReasons = flags('Video');
      stream.audioReasons = flags('Audio');
      stream.containerReasons = flags('Container');
    }

    // Live TV keeps its own sessions: a channel has no media file, so it cannot
    // live in the on-demand registry. Same dashboard, one row per viewer.
    for (const row of await this.liveTvSessions.listForActivity()) {
      streams.push({
        sessionId: row.sessionId,
        userId: row.userId,
        username: row.username,
        mediaId: row.channelId,
        mediaFileId: 0,
        mediaTitle: row.channelName,
        mediaType: 'livetv',
        episodeId: null,
        episodeLabel: null,
        posterUrl: null,
        mode: row.mode === 'direct' ? 'directplay' : row.mode,
        quality: row.sourceName ?? 'Live',
        hwAccel,
        device: row.device,
        systemName: null,
        appVersion: null,
        startedAt: new Date(row.startedAt).toISOString(),
        lastActivity: new Date(row.lastSeenAt).toISOString(),
        positionSeconds: 0,
        durationSeconds: 0,
        container: row.container,
        videoCodec: row.videoCodec,
        videoResolution: null,
        videoBitrate: null,
        audioCodec: row.audioCodec,
        audioChannels: null,
        audioLanguage: null,
        outputContainer: row.container,
        outputBitrate: null,
        audioOutputCodec: null,
        audioOutputBitrateBps: null,
        audioMode: row.mode === 'transcode' ? 'transcode' : 'copy',
        transcodePercent: null,
        clientTonemap: false,
        videoReasons: [],
        audioReasons: [],
        containerReasons: [],
        qoe: this.qoe.liveSummary(row.sessionId),
        engineStatus: this.engine?.status ?? 'off',
        job: null,
      });
    }

    return streams;
  }

  /** The engine's sessions by sid when it runs playback and answers; null otherwise. */
  private async engineSessions(): Promise<Map<string, SessionSnapshot> | null> {
    if (!this.engine?.runtime) return null;
    try {
      return new Map((await this.engine.listSessions()).map((s) => [s.sessionId, s]));
    } catch (err) {
      this.logger.warn(`engine sessions not listed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Current on-disk transcode cache footprint, for the admin UI. */
  @Get('transcode-cache')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async transcodeCacheStats(): Promise<{ entries: number; bytes: number }> {
    if (!this.engine?.runtime) return { entries: 0, bytes: 0 };
    const { entries, usedBytes } = await this.engine.cache();
    return { entries: entries.length, bytes: usedBytes };
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
    return { ok: true, ...(await this.purge({})) };
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
    const owner = Number.isFinite(scopedUser) ? scopedUser : undefined;
    return { ok: true, ...(await this.purge({ mediaFileId, userId: owner })) };
  }

  /** Purges the engine's cache (live entries stay). */
  private async purge(f: {
    mediaFileId?: number;
    userId?: number;
  }): Promise<{ entries: number; bytes: number }> {
    if (!this.engine?.runtime) return { entries: 0, bytes: 0 };
    const ownerId = f.userId === undefined ? undefined : String(f.userId);
    const { entries } = await this.engine.cache();
    const gone = entries.filter(
      (e) =>
        !e.live &&
        (f.mediaFileId === undefined || e.mediaFileId === f.mediaFileId) &&
        (ownerId === undefined || e.ownerId === ownerId),
    );
    await this.engine.purgeCache({ mediaFileId: f.mediaFileId, ownerId });
    return { entries: gone.length, bytes: gone.reduce((n, e) => n + e.bytes, 0) };
  }

  @Post('streams/:sessionId/command')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  sendPlayerCommand(
    @Param('sessionId') sessionId: string,
    @Body() body: { action: 'pause' | 'play' | 'stop' | 'message'; message?: string },
  ) {
    const live = this.liveSessions.peek(sessionId);
    if (!live || live.userId == null) {
      throw new BadRequestException('Session not found');
    }

    const cmdEvent = {
      type: 'player.command' as const,
      sessionId,
      mediaFileId: live.mediaFileId,
      userId: live.userId,
      action: body.action,
      message: body.message,
    };
    const sseConnectionId = live.sseConnectionId;
    if (sseConnectionId && this.eventsService.hasConnection(sseConnectionId)) {
      this.eventsService.emitToConnection(sseConnectionId, cmdEvent);
    } else {
      // Clients without a bound SSE connection: every tab/device for
      // this user receives the command — they must filter on sessionId.
      this.eventsService.emitToUser(live.userId, cmdEvent);
    }

    if (body.action === 'stop') {
      this.liveSessions.stop(sessionId);
      if (this.engine?.runtime) {
        void this.engine
          .deleteSession(sessionId)
          .catch((err: Error) => this.logger.warn(`engine session ${sessionId} not deleted: ${err.message}`));
      }
    }

    return { ok: true };
  }
}
