import {
  Controller,
  Delete,
  Get,
  Post,
  Body,
  Param,
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
import { RootFolder } from '../root-folders/entities/root-folder.entity';
import { QbittorrentService } from '../download-clients/qbittorrent.service';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { BackupService } from './backup.service';
import { LogBufferService } from './log-buffer.service';
import { EventsService } from './events.service';
import { Observable } from 'rxjs';
import {
  HW_ACCEL_LABEL,
  type HwAccelType,
  TranscodingService,
} from '../streaming/transcoding';
import { ActiveStreamTracker } from '../streaming/active-stream-tracker.service';
import { PlaybackService } from '../streaming/playback.service';
import { MediaFile } from '../media/entities/media-file.entity';
import { Episode } from '../media/entities/episode.entity';

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
  videoPlaybackMode: string; // "Lecture directe" / "Transcodage (QSV)"
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

@Controller('system')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class SystemController {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Indexer)
    private readonly indexerRepo: Repository<Indexer>,
    @InjectRepository(DownloadClient)
    private readonly clientRepo: Repository<DownloadClient>,
    @InjectRepository(RootFolder)
    private readonly rootFolderRepo: Repository<RootFolder>,
    private readonly qbittorrent: QbittorrentService,
    private readonly backup: BackupService,
    private readonly logBuffer: LogBufferService,
    private readonly eventsService: EventsService,
    private readonly transcodingService: TranscodingService,
    private readonly activeStreamTracker: ActiveStreamTracker,
    private readonly playbackService: PlaybackService,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
  ) {}

  @Sse('events')
  events(): Observable<MessageEvent> {
    return this.eventsService.getStream();
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
    const [[moviesRow], [seriesRow], [pendingRow], rootFolders] =
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
        this.rootFolderRepo.find({ order: { path: 'ASC' } }),
      ]);

    const diskSpace: DiskSpaceEntry[] = rootFolders.map((f) => {
      try {
        const stat = fs.statfsSync(f.path);
        return {
          path: f.path,
          label: f.label ?? null,
          freeSpace: stat.bfree * stat.bsize,
          totalSpace: stat.blocks * stat.bsize,
        };
      } catch {
        return {
          path: f.path,
          label: f.label ?? null,
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

    // Collect all mediaFileIds to batch-load streamInfo and playback state
    const allSessions: {
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
    }[] = [];

    for (const s of this.transcodingService.getActiveSessions()) {
      allSessions.push({
        sessionId: s.id,
        userId: s.userId ?? null,
        username: s.username ?? null,
        mediaFileId: s.mediaFileId,
        mediaTitle: s.mediaTitle ?? '',
        mediaType: s.mediaType ?? '',
        posterUrl: s.posterUrl ?? null,
        mode: s.remux ? 'remux' : 'transcode',
        quality: s.quality,
        hwAccelVal: s.remux ? 'none' : (s.actualHwAccel ?? hwAccel),
        startedAt: (s.startedAt ?? new Date()).toISOString(),
        lastActivity: new Date(s.lastAccess).toISOString(),
      });
    }

    for (const s of this.activeStreamTracker.getActive()) {
      allSessions.push({
        sessionId: `dp-${s.userId}-${s.mediaFileId}`,
        userId: s.userId,
        username: s.username,
        mediaFileId: s.mediaFileId,
        mediaTitle: s.mediaTitle,
        mediaType: s.mediaType,
        posterUrl: s.posterUrl,
        mode: 'directplay',
        quality: 'original',
        hwAccelVal: 'none',
        startedAt: s.startedAt.toISOString(),
        lastActivity: s.lastActivity.toISOString(),
      });
    }

    // Track episodeId per stream index for resolution later
    const streamEpisodeIds: (number | null)[] = [];

    // Batch-load media files for streamInfo
    const mediaFileIds = [...new Set(allSessions.map((s) => s.mediaFileId))];
    const mediaFiles = mediaFileIds.length
      ? await this.mediaFileRepo.findByIds(mediaFileIds)
      : [];
    const mediaFileMap = new Map(mediaFiles.map((mf) => [mf.id, mf]));

    for (const s of allSessions) {
      const mf = mediaFileMap.get(s.mediaFileId);
      const si = mf?.streamInfo;
      const v = si?.video?.[0];
      const a = si?.audio?.[0];

      // Playback state (position/duration + episodeId)
      let positionSeconds = 0;
      let durationSeconds = si?.durationSeconds ?? 0;
      let episodeId: number | null = null;
      if (s.userId && mf?.mediaId) {
        try {
          // `playback_states` is keyed by (user, media, episode?). Series
          // episodes carry an episodeId — the media-file row tells us
          // which one — so we pass it through, otherwise the lookup
          // hits the IS NULL branch (movies) and returns nothing.
          const ps = await this.playbackService.getState(
            s.userId,
            mf.mediaId,
            mf.episodeId ?? undefined,
          );
          if (ps) {
            positionSeconds = ps.positionSeconds;
            if (ps.durationSeconds > 0) durationSeconds = ps.durationSeconds;
            episodeId = ps.episodeId ?? null;
          }
        } catch {
          /* ignore */
        }
      }

      // Determine playback modes
      let videoPlaybackMode = 'Lecture directe';
      let outputContainer: string | null = null;
      let outputBitrate: number | null = null;
      let audioOutputCodec: string | null = null;
      let audioOutputBitrateBps: number | null = null;
      let audioMode: 'direct' | 'copy' | 'transcode' = 'direct';
      // Single source of truth: the audio plan stream-builder stored at
      // playback-info time. mode/codec/bitrate are read directly — no
      // re-derivation, no string comparison gymnastics.
      const audioPlan = this.activeStreamTracker.getAudioPlan(s.mediaFileId);

      if (s.mode === 'transcode') {
        videoPlaybackMode = `Transcodage (${HW_ACCEL_LABEL[hwAccel] ?? hwAccel.toUpperCase()})`;
        outputContainer = 'HLS';
        const profile = { '1080p': 8, '720p': 4, '480p': 2 }[s.quality];
        outputBitrate = profile ? profile * 1_000_000 : null;
        if (audioPlan) {
          audioMode = audioPlan.mode;
          audioOutputCodec = audioPlan.codec;
          audioOutputBitrateBps =
            audioPlan.mode === 'transcode' ? audioPlan.bitrateBps : null;
        }
      } else if (s.mode === 'remux') {
        outputContainer = 'HLS';
        outputBitrate = (v?.bitRate ?? 0) + (a?.bitRate ?? 0) || null;
        if (audioPlan) {
          audioMode = audioPlan.mode;
          audioOutputCodec = audioPlan.codec;
          audioOutputBitrateBps =
            audioPlan.mode === 'transcode' ? audioPlan.bitrateBps : null;
        } else {
          audioMode = 'copy';
        }
      }

      const sourceResLabel =
        v?.width && v?.height
          ? v.height >= 2160
            ? '4K'
            : v.height >= 1080
              ? '1080p'
              : v.height >= 720
                ? '720p'
                : `${v.width}x${v.height}`
          : null;
      // For transcode sessions, show the target quality, not the source resolution
      const resLabel =
        s.mode === 'transcode' && s.quality !== 'original'
          ? s.quality
          : sourceResLabel;

      streamEpisodeIds.push(episodeId);
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
        videoPlaybackMode,
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
      ...new Set(streamEpisodeIds.filter((id): id is number => !!id)),
    ];
    if (uniqueEpIds.length) {
      const episodes = await this.episodeRepo.find({
        where: uniqueEpIds.map((id) => ({ id })),
        relations: ['season'],
      });
      const epMap = new Map(episodes.map((e) => [e.id, e]));
      for (let i = 0; i < streams.length; i++) {
        const epId = streamEpisodeIds[i];
        if (epId) {
          const ep = epMap.get(epId);
          if (ep) {
            const label = `S${ep.season?.seasonNumber ?? '?'}:E${ep.episodeNumber}`;
            streams[i].episodeLabel = ep.title
              ? `${label} - ${ep.title}`
              : label;
          }
        }
      }
    }

    // Fill transcode progress for non-directplay sessions
    const transcodeSessions = this.transcodingService.getActiveSessions();
    for (const stream of streams) {
      if (stream.mode !== 'directplay') {
        const ts = transcodeSessions.find((s) => s.id === stream.sessionId);
        if (ts) {
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
      }
    }

    // Deduplicate: when a user switches quality, multiple transcode sessions
    // exist for the same file. Keep only the most recently accessed one per user+file.
    // Also prefer sessions accessed in the last 15s over stale ones.
    const deduped = new Map<string, ActiveStreamDto>();
    const recentCutoff = new Date(Date.now() - 15_000).toISOString();
    for (const stream of streams) {
      const key = `${stream.userId ?? 0}-${stream.mediaFileId}`;
      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, stream);
      } else {
        // Prefer the recently active session; if both recent or both stale, pick latest
        const existingRecent = existing.lastActivity > recentCutoff;
        const streamRecent = stream.lastActivity > recentCutoff;
        if (
          (!existingRecent && streamRecent) ||
          stream.lastActivity > existing.lastActivity
        ) {
          deduped.set(key, stream);
        }
      }
    }

    return Array.from(deduped.values());
  }

  @Delete('streams/:sessionId')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  killStream(@Param('sessionId') sessionId: string) {
    if (sessionId.startsWith('dp-')) {
      // Direct play session — can't really kill it, just untrack
      const parts = sessionId.replace('dp-', '').split('-');
      const userId = parseInt(parts[0], 10);
      const mediaFileId = parseInt(parts[1], 10);
      if (userId && mediaFileId) {
        this.activeStreamTracker.unregister(userId, mediaFileId);
      }
    } else {
      // Transcode session — kill by session map key directly
      this.transcodingService.killSessionById(sessionId);
    }
    return { ok: true };
  }

  @Post('streams/:sessionId/command')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  sendPlayerCommand(
    @Param('sessionId') sessionId: string,
    @Body() body: { action: 'pause' | 'play' | 'stop'; message?: string },
  ) {
    // Parse userId and mediaFileId from sessionId
    let userId = 0;
    let mediaFileId = 0;

    if (sessionId.startsWith('dp-')) {
      const parts = sessionId.replace('dp-', '').split('-');
      userId = parseInt(parts[0], 10);
      mediaFileId = parseInt(parts[1], 10);
    } else {
      // Transcode session — look up from active sessions
      const session = this.transcodingService
        .getActiveSessions()
        .find((s) => s.id === sessionId);
      if (session) {
        userId = session.userId ?? 0;
        mediaFileId = session.mediaFileId;
      }
    }

    if (!userId || !mediaFileId) {
      throw new BadRequestException('Session not found');
    }

    this.eventsService.emit({
      type: 'player.command',
      mediaFileId,
      userId,
      action: body.action,
      message: body.message,
    });

    // If stop, also kill the transcode session
    if (body.action === 'stop') {
      if (sessionId.startsWith('dp-')) {
        this.activeStreamTracker.unregister(userId, mediaFileId);
      } else {
        this.transcodingService.killSessionById(sessionId);
      }
    }

    return { ok: true };
  }
}
