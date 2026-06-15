import {
  Controller,
  Delete,
  Get,
  Post,
  Body,
  Param,
  ParseIntPipe,
  Query,
  Res,
  Sse,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { Indexer } from '../indexers/entities/indexer.entity';
import { DownloadClient } from '../download-clients/entities/download-client.entity';
import { Library } from '../libraries/entities/library.entity';
import { QbittorrentService } from '../download-clients/qbittorrent.service';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { BackupService } from './backup.service';
import { LogBufferService } from './log-buffer.service';
import { EventsService } from './events.service';
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
import { ActiveStreamTracker } from '../streaming/active-stream-tracker.service';
import {
  type LiveSessionSnapshot,
  LiveSessionRegistry,
} from '../streaming/live-session.service';
import { StreamLifetime } from '../streaming/lifetime-constants';
import { PlaybackService } from '../streaming/playback.service';
import { MediaFile } from '../media/entities/media-file.entity';
import { Episode } from '../media/entities/episode.entity';
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
  indexers: { enabled: number; total: number };
  downloadClients: ServiceStatus[];
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
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Indexer)
    private readonly indexerRepo: Repository<Indexer>,
    @InjectRepository(DownloadClient)
    private readonly clientRepo: Repository<DownloadClient>,
    @InjectRepository(Library)
    private readonly libraryRepo: Repository<Library>,
    private readonly qbittorrent: QbittorrentService,
    private readonly backup: BackupService,
    private readonly logBuffer: LogBufferService,
    private readonly eventsService: EventsService,
    private readonly transcodingService: TranscodingService,
    private readonly transcodeCache: TranscodeCacheService,
    private readonly activeStreamTracker: ActiveStreamTracker,
    private readonly liveSessions: LiveSessionRegistry,
    private readonly playbackService: PlaybackService,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
  ) {}

  @Sse('events')
  events(@CurrentUser() user: User): Observable<MessageEvent> {
    return this.eventsService.getStream(user.id);
  }

  @Get('health')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async health(): Promise<HealthReport> {
    const [dbStatus, indexers, clients] = await Promise.all([
      this.checkDatabase(),
      this.checkIndexers(),
      this.checkClients(),
    ]);

    return {
      version: APP_VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
      database: dbStatus,
      indexers,
      downloadClients: clients,
    };
  }

  private async checkDatabase(): Promise<ServiceStatus> {
    try {
      await this.dataSource.query('SELECT 1');
      return { name: 'PostgreSQL', ok: true };
    } catch (e) {
      return { name: 'PostgreSQL', ok: false, message: (e as Error).message };
    }
  }

  private async checkIndexers(): Promise<{ enabled: number; total: number }> {
    const [enabled, total] = await Promise.all([
      this.indexerRepo.count({ where: { enabled: true } }),
      this.indexerRepo.count(),
    ]);
    return { enabled, total };
  }

  @Get('stats')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  async stats(): Promise<StatsReport> {
    const [[moviesRow], [seriesRow], [pendingRow], libraries] =
      await Promise.all([
        this.dataSource.query(
          `SELECT COUNT(*)::int AS count FROM media WHERE type = 'movie'`,
        ),
        this.dataSource.query(
          `SELECT COUNT(*)::int AS count FROM media WHERE type = 'series'`,
        ),
        this.dataSource.query(
          `SELECT COUNT(*)::int AS count FROM requests WHERE status = 'pending'`,
        ),
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
      pendingRequests: pendingRow.count,
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

  private async checkClients(): Promise<ServiceStatus[]> {
    const clients = await this.clientRepo.find({ where: { enabled: true } });
    return Promise.all(
      clients.map(async (c) => {
        const result = await this.qbittorrent.testConnection(c.settings);
        return {
          name: c.name,
          ok: result.ok,
          message: result.ok ? undefined : result.message,
        };
      }),
    );
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

    // Legacy direct-play paths that bypass playback-info still surface here;
    // their (user, file) pair isn't represented by any LiveSession so we read
    // from the tracker. Snapshot once — the dashboard reads it twice.
    const directPlaySessions = this.activeStreamTracker.getActive();

    // Collect lookups before the per-session loop so we batch DB hits.
    const mediaFileIds = [
      ...new Set([
        ...live.map((s) => s.mediaFileId),
        ...directPlaySessions.map((s) => s.mediaFileId),
      ]),
    ];
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
      transcodeSession: TranscodeSession | undefined;
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
        deviceLabel:
          session.deviceLabel ??
          (session.userId != null
            ? this.activeStreamTracker.getDeviceName(
                session.userId,
                session.mediaFileId,
              )
            : null),
        transcodeSession: ts,
        audioPlan: session.audioPlan,
        // The LiveSession keeps the playhead fresh on every heartbeat — read
        // it straight from memory instead of a per-row playback_states query.
        position: session.position,
        episodeId: mediaFileMap.get(session.mediaFileId)?.episodeId ?? null,
      });
    }

    // Legacy direct-play fallback: tracker entries without a matching
    // LiveSession (typically clients that hit /stream/:mediaFileId
    // without a prior playback-info call).
    const liveByKey = new Set(
      live.map((s) => `${s.userId ?? 0}-${s.mediaFileId}`),
    );
    for (const dp of directPlaySessions) {
      const key = `${dp.userId}-${dp.mediaFileId}`;
      if (liveByKey.has(key)) continue;
      work.push({
        sessionId: `dp-${dp.userId}-${dp.mediaFileId}`,
        userId: dp.userId,
        username: dp.username,
        mediaFileId: dp.mediaFileId,
        mediaTitle: dp.mediaTitle,
        mediaType: dp.mediaType,
        posterUrl: dp.posterUrl,
        mode: 'directplay',
        quality: 'original',
        hwAccelVal: 'none',
        startedAt: dp.startedAt.toISOString(),
        lastActivity: dp.lastActivity.toISOString(),
        deviceLabel: this.activeStreamTracker.getDeviceName(
          dp.userId,
          dp.mediaFileId,
        ),
        transcodeSession: undefined,
        audioPlan: null,
        position: 0,
        episodeId: null,
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
   * command targets. The dashboard hands us three flavours of id:
   *   - `dp-<userId>-<mediaFileId>` — legacy direct-play tracker entry.
   *   - A `LiveSession.sessionId` UUID — the canonical id since #300.
   *   - A `TranscodeSession.id` hash — left in for completeness; the
   *     dashboard hasn't emitted these in a while but a stale client
   *     tab could still send one.
   * Returns null when none of the three lookups produces a (user, file)
   * pair the command can act on.
   */
  private resolveStreamCommandTarget(sessionId: string): {
    userId: number;
    mediaFileId: number;
    profileHash: string | null;
    isDirectPlay: boolean;
  } | null {
    if (sessionId.startsWith('dp-')) {
      const parts = sessionId.replace('dp-', '').split('-');
      const userId = parseInt(parts[0], 10);
      const mediaFileId = parseInt(parts[1], 10);
      if (!userId || !mediaFileId) return null;
      return { userId, mediaFileId, profileHash: null, isDirectPlay: true };
    }
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

    this.eventsService.emitToUser(target.userId, {
      type: 'player.command',
      mediaFileId: target.mediaFileId,
      userId: target.userId,
      action: body.action,
      message: body.message,
    });

    if (body.action === 'stop') {
      if (target.isDirectPlay) {
        this.activeStreamTracker.unregister(target.userId, target.mediaFileId);
      } else if (target.profileHash) {
        // Admin stop is a force-kill: reap every ffmpeg variant of the job
        // (main / early / remux / per-audio), not just the main one — the
        // companions would otherwise idle on until the reaper sweeps them.
        this.transcodingService.killSessionsForJob(
          target.mediaFileId,
          target.userId,
          target.profileHash,
        );
      }
      this.liveSessions.stop(sessionId);
    }

    return { ok: true };
  }
}
