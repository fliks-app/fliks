import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DownloadTask } from './entities/download-task.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { Episode } from '../media/entities/episode.entity';
import { Media } from '../media/entities/media.entity';
import { User } from '../users/entities/user.entity';
import { Season } from '../media/entities/season.entity';
import { StreamingService, ResolvedFile } from '../streaming/streaming.service';
import { TranscodingService, PROFILES } from '../streaming/transcoding.service';
import { EventsService } from '../scheduler/events.service';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * Run an FFmpeg command with reliable progress tracking via `-progress pipe:1`.
 * Parses structured `out_time_us` from stdout (not affected by pipe buffering).
 * Stderr is kept for error diagnostics only.
 */
function runFfmpegWithProgress(
  args: string[],
  durationSeconds: number,
  onProgress: (pct: number) => void,
  onJobRef: (kill: () => void) => void,
  onJobDone: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const fullArgs = [
      ...args.slice(0, -1),
      '-progress',
      'pipe:1',
      args[args.length - 1],
    ];
    const proc = spawn('ffmpeg', fullArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onJobRef(() => proc.kill('SIGTERM'));

    let lastPct = -1;
    let stdoutBuf = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      // Process complete lines
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        const m = line.match(/^out_time_us=(\d+)/);
        if (m) {
          const secs = parseInt(m[1]) / 1_000_000;
          const pct =
            durationSeconds > 0
              ? Math.min(99, Math.round((secs / durationSeconds) * 100))
              : 0;
          if (pct !== lastPct && pct >= 0) {
            lastPct = pct;
            onProgress(pct);
          }
        }
      }
    });

    // Keep stderr for error diagnostics
    let stderrTail = '';
    proc.stderr!.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4096);
    });

    proc.on('close', (code) => {
      onJobDone();
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}\n${stderrTail}`));
    });
    proc.on('error', (err) => {
      onJobDone();
      reject(err);
    });
  });
}

/** Max concurrent FFmpeg download transcodes */
const MAX_CONCURRENT_DOWNLOADS = 2;

/** Image-based subtitle codecs that cannot be converted to mov_text */
const BITMAP_SUB_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'dvd_subtitle',
  'dvb_subtitle',
  'xsub',
]);

export interface DownloadQuality {
  key: string;
  label: string;
  estimatedSize: number;
}

@Injectable()
export class InappDownloadsService implements OnModuleInit {
  private readonly log = new Logger(InappDownloadsService.name);
  private readonly cachePath: string;
  /** Active transcode processes — keyed by task ID */
  private readonly activeJobs = new Map<number, { kill: () => void }>();
  /** Concurrency control for FFmpeg download processes */
  private runningCount = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(
    @InjectRepository(DownloadTask)
    private readonly taskRepo: Repository<DownloadTask>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    @InjectRepository(SubtitleFile)
    private readonly subtitleRepo: Repository<SubtitleFile>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    private readonly streaming: StreamingService,
    private readonly transcoding: TranscodingService,
    private readonly events: EventsService,
    private readonly config: ConfigService,
  ) {
    this.cachePath = this.config.get<string>(
      'DOWNLOAD_CACHE_PATH',
      '/tmp/fliks-downloads',
    );
  }

  async onModuleInit() {
    // Mark any in-progress tasks as failed (server restarted, ffmpeg processes are gone)
    const stale = await this.taskRepo.find({
      where: [
        { status: 'transcoding' },
        { status: 'pending' },
      ],
    });
    if (stale.length) {
      for (const task of stale) {
        if (task.sessionDir) {
          await fs.rm(task.sessionDir, { recursive: true, force: true }).catch(() => {});
        }
      }
      await this.taskRepo.update(
        stale.map((t) => t.id),
        {
          status: 'failed',
          error: 'Server restarted during processing',
          sessionDir: null,
        },
      );
      this.log.warn(
        `Marked ${stale.length} in-progress downloads as failed (server restart)`,
      );
    }
  }

  async getAvailableQualities(
    mediaFileId: number,
    user?: User,
  ): Promise<DownloadQuality[]> {
    const resolved = await this.streaming.resolveFile(mediaFileId, user);
    const info = resolved.mediaFile.streamInfo;
    const fileSize = resolved.size;
    const video = info?.video?.[0];
    const sourceWidth = video?.width ?? 1920;
    const sourceHeight = video?.height ?? 1080;
    const sourceBitrate = info?.formatBitRate ?? 0;

    const qualities: DownloadQuality[] = [];

    for (const p of PROFILES) {
      // Skip profiles with higher resolution than the source (upscaling is
      // pointless). Use > instead of >= so the profile matching the source
      // resolution is included — that's the "max quality" download option.
      if (p.maxWidth > sourceWidth && p.maxHeight > sourceHeight) continue;
      const videoBps = this.parseBitrate(p.videoBitrate);
      const audioBps = this.parseBitrate(p.audioBitrate);
      const duration = info?.durationSeconds ?? 0;
      const estimated =
        duration > 0
          ? Math.floor(((videoBps + audioBps) * duration) / 8)
          : Math.floor(
              fileSize * (videoBps / Math.max(sourceBitrate, videoBps)),
            );
      qualities.push({
        key: p.name,
        label: `${p.name} (~${this.formatSize(estimated)})`,
        estimatedSize: estimated,
      });
    }

    return qualities;
  }

  async create(
    user: User,
    mediaFileId: number,
    quality: string,
    deviceProfile?: {
      supportsHdr?: boolean;
      audioCodecs?: string[];
      maxAudioChannels?: number;
    },
    deviceId?: string,
  ): Promise<DownloadTask> {
    const resolved = await this.streaming.resolveFile(mediaFileId, user);
    const file = resolved.mediaFile;

    // Check for existing task (scoped by device when provided)
    const where: Record<string, any> = {
      user: { id: user.id },
      mediaFile: { id: mediaFileId },
      quality,
    };
    if (deviceId) where.deviceId = deviceId;
    const existing = await this.taskRepo.findOne({ where });
    if (existing && existing.status !== 'failed') {
      return existing;
    }
    if (existing?.status === 'failed') {
      await this.taskRepo.remove(existing);
    }

    let episodeLabel: string | undefined;
    this.log.log(
      `Download create: mediaFileId=${mediaFileId}, episodeId=${file.episodeId ?? 'null'}`,
    );
    if (file.episodeId) {
      const ep = await this.episodeRepo.findOne({
        where: { id: file.episodeId },
        relations: ['season'],
      });
      if (ep) {
        const sn = String(ep.season.seasonNumber).padStart(2, '0');
        const en = String(ep.episodeNumber).padStart(2, '0');
        episodeLabel = `S${sn}E${en}${ep.title ? ' - ' + ep.title : ''}`;
      }
    }

    const task = this.taskRepo.create({
      user: { id: user.id } as User,
      deviceId,
      media: { id: file.mediaId } as Media,
      episode:
        file.episodeId != null ? ({ id: file.episodeId } as Episode) : null,
      mediaFile: { id: mediaFileId } as MediaFile,
      quality,
      status: 'pending',
      episodeLabel,
    });
    const saved = await this.taskRepo.save(task);

    const dp = deviceProfile ?? {};
    void this.runProgressiveTranscode(saved.id, resolved, quality, dp);
    return saved;
  }

  async list(userId: number, deviceId?: string): Promise<DownloadTask[]> {
    const where: Record<string, any> = { user: { id: userId } };
    if (deviceId) where.deviceId = deviceId;
    return this.taskRepo.find({
      where,
      relations: ['media'],
      order: { createdAt: 'DESC' },
    });
  }

  async getOne(userId: number, taskId: number): Promise<DownloadTask> {
    const task = await this.taskRepo.findOne({
      where: { id: taskId },
      relations: ['media'],
    });
    if (!task) throw new NotFoundException(`Download #${taskId} not found`);
    if (task.userId !== userId) throw new ForbiddenException();
    return task;
  }

  async retry(
    userId: number,
    taskId: number,
    deviceProfile?: {
      supportsHdr?: boolean;
      audioCodecs?: string[];
      maxAudioChannels?: number;
    },
  ): Promise<DownloadTask> {
    const task = await this.getOne(userId, taskId);
    if (task.status !== 'failed' && task.status !== 'expired') {
      throw new BadRequestException(
        'Only failed or expired downloads can be retried',
      );
    }

    // Clean up leftover session dir
    if (task.sessionDir) {
      await fs.rm(task.sessionDir, { recursive: true, force: true }).catch(() => {});
    }

    // Reset task state
    await this.taskRepo.update(task.id, {
      status: 'pending',
      progress: 0,
      sessionDir: null,
      segmentCount: null,
      totalSegments: null,
      error: undefined,
      fileSize: undefined,
      subtitles: undefined,
      clientDownloadedAt: undefined,
    });

    const resolved = await this.streaming.resolveFile(task.mediaFileId);
    const dp = deviceProfile ?? {};
    void this.runProgressiveTranscode(task.id, resolved, task.quality, dp);

    return this.getOne(userId, taskId);
  }

  /**
   * Return the absolute path to a segment file for a progressive download.
   * Waits up to 30s for the segment to appear and stabilise (FFmpeg may still
   * be writing it). Throws if the task isn't progressive or timed out.
   */
  async getSegmentPath(
    userId: number,
    taskId: number,
    filename: string,
  ): Promise<string> {
    const task = await this.getOne(userId, taskId);
    if (!task.sessionDir) {
      throw new BadRequestException('Not a segment-based download');
    }
    // Sanitise filename — only allow init.mp4 and seg-NNNN.m4s
    if (!/^(init\.mp4|seg-\d{4}\.m4s)$/.test(filename)) {
      throw new BadRequestException('Invalid segment name');
    }
    const segPath = path.join(task.sessionDir, filename);
    return this.waitForFile(segPath, 30_000);
  }

  /** Progresssive download status for polling */
  async getProgressiveStatus(
    userId: number,
    taskId: number,
  ): Promise<{
    segmentCount: number;
    totalSegments: number | null;
    segmentDuration: number;
    done: boolean;
  }> {
    const task = await this.getOne(userId, taskId);
    return {
      segmentCount: task.segmentCount ?? 0,
      totalSegments: task.totalSegments,
      segmentDuration: task.segmentDuration ?? 3,
      done: task.status === 'ready',
    };
  }

  /**
   * Wait for a file to exist and stop growing (stability check).
   * Used for serving HLS segments that FFmpeg may still be writing.
   */
  private async waitForFile(
    filePath: string,
    timeoutMs: number,
  ): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const stat = await fs.stat(filePath);
        // File exists — wait 50ms then check size didn't change (stable)
        await new Promise((r) => setTimeout(r, 50));
        const stat2 = await fs.stat(filePath);
        if (stat2.size === stat.size && stat.size > 0) {
          return filePath;
        }
      } catch {
        // File doesn't exist yet — wait and retry
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new NotFoundException(
      `Segment not available within ${timeoutMs / 1000}s`,
    );
  }

  async ackDownloaded(userId: number, taskId: number): Promise<void> {
    const task = await this.getOne(userId, taskId);
    await this.taskRepo.update(task.id, { clientDownloadedAt: new Date() });
    if (task.sessionDir) {
      await fs.rm(task.sessionDir, { recursive: true, force: true }).catch(() => {});
      await this.taskRepo.update(task.id, { sessionDir: null });
    }
  }

  /** Cleanup session dirs older than maxAge that were never downloaded by client */
  async cleanupStaleFiles(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const stale = await this.taskRepo
      .createQueryBuilder('t')
      .where('t.status = :status', { status: 'ready' })
      .andWhere('t."sessionDir" IS NOT NULL')
      .andWhere('t."clientDownloadedAt" IS NULL')
      .andWhere('t."updatedAt" < :cutoff', { cutoff })
      .getMany();

    for (const task of stale) {
      if (task.sessionDir) {
        await fs.rm(task.sessionDir, { recursive: true, force: true }).catch(() => {});
      }
      await this.taskRepo.update(task.id, {
        sessionDir: null,
        status: 'expired',
        error: 'File expired — client never downloaded',
      });
    }
    if (stale.length) {
      this.log.log(`Cleanup: removed ${stale.length} stale session dirs`);
    }
    return stale.length;
  }

  async delete(userId: number, taskId: number): Promise<void> {
    const task = await this.getOne(userId, taskId);
    this.activeJobs.get(taskId)?.kill();
    this.activeJobs.delete(taskId);
    if (task.sessionDir) {
      await fs.rm(task.sessionDir, { recursive: true, force: true }).catch(() => {});
    }
    await this.taskRepo.remove(task);
  }

  /** Wait until a concurrency slot is available */
  private acquireSlot(): Promise<void> {
    if (this.runningCount < MAX_CONCURRENT_DOWNLOADS) {
      this.runningCount++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waitQueue.push(resolve));
  }

  private releaseSlot(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next(); // hand the slot to the next waiter
    } else {
      this.runningCount--;
    }
  }

  /**
   * Transcode to HLS segments (fMP4) that can be downloaded incrementally as
   * they appear on disk. Subtitle extraction runs in parallel from the source.
   * Web clients get a single concatenated fMP4 via `/file`; native clients
   * download segments individually via `/segment/:filename`.
   */
  private async runProgressiveTranscode(
    taskId: number,
    resolved: ResolvedFile,
    quality: string,
    deviceProfile: {
      supportsHdr?: boolean;
      audioCodecs?: string[];
      maxAudioChannels?: number;
    } = {},
  ): Promise<void> {
    const profile = PROFILES.find((p) => p.name === quality);
    if (!profile) {
      await this.taskRepo.update(taskId, {
        status: 'failed',
        error: `Unknown quality: ${quality}`,
      });
      return;
    }

    await this.acquireSlot();
    this.log.log(
      `Download #${taskId}: progressive slot acquired (${this.runningCount}/${MAX_CONCURRENT_DOWNLOADS})`,
    );
    try {
      const sessionDir = path.join(this.cachePath, `dl-${taskId}`);
      await fs.mkdir(sessionDir, { recursive: true });

      const inputPath = resolved.absolutePath;
      const info = resolved.mediaFile.streamInfo;
      const video = info?.video?.[0];
      const isHdr = video?.colorSpace === 'bt2020nc' || video?.bitDepth === 10;
      const hwAccel = this.transcoding.getDetectedHwAccel();
      const duration = info?.durationSeconds ?? 0;
      const segmentDuration = 3;
      const totalSegments =
        duration > 0 ? Math.ceil(duration / segmentDuration) : null;

      const subtitles = await this.subtitleRepo.find({
        where: { mediaFile: { id: resolved.mediaFile.id } },
      });
      const crop = (video as any)?.crop as
        | { width: number; height: number; x: number; y: number }
        | undefined;
      const args = this.buildFullFileFfmpegArgs(
        inputPath,
        profile,
        hwAccel,
        isHdr,
        subtitles,
        resolved,
        crop,
        { dir: sessionDir, segmentDuration },
      );

      await this.taskRepo.update(taskId, {
        status: 'transcoding',
        sessionDir,
        segmentDuration,
        totalSegments,
        segmentCount: 0,
      });
      this.log.log(
        `Download #${taskId}: progressive transcode → ${quality} (${hwAccel}), est. ${totalSegments} segments`,
      );

      // Monitor segment creation (1s interval) — updates DB + SSE.
      const monitorInterval = setInterval(async () => {
        try {
          const files = await fs.readdir(sessionDir);
          const count = files.filter((f) => /^seg-\d+\.m4s$/.test(f)).length;
          const pct =
            totalSegments && totalSegments > 0
              ? Math.min(99, Math.round((count / totalSegments) * 100))
              : 0;
          await this.taskRepo.update(taskId, {
            segmentCount: count,
            progress: pct,
          });
          this.events.emit({
            type: 'download.progress',
            downloadId: taskId,
            progress: pct,
          });
        } catch {
          /* dir deleted → ignore */
        }
      }, 1000);

      // Extract VTT subtitles in parallel from the *source* file.
      const vttPromise = this.extractSubtitlesAsVtt(
        inputPath,
        taskId,
        resolved.mediaFile.streamInfo?.subtitles ?? [],
      );

      try {
        await runFfmpegWithProgress(
          args,
          duration,
          () => {}, // progress tracked via segment monitor
          (kill) => this.activeJobs.set(taskId, { kill }),
          () => this.activeJobs.delete(taskId),
        );

        clearInterval(monitorInterval);

        // Final segment count after FFmpeg exits
        const files = await fs.readdir(sessionDir);
        const finalCount = files.filter((f) =>
          /^seg-\d+\.m4s$/.test(f),
        ).length;

        const vttFiles = await vttPromise;
        const subtitleMeta = vttFiles.map((v) => ({
          language: v.language,
          forced: v.forced,
          filename: path.basename(v.path),
        }));

        await this.taskRepo.update(taskId, {
          status: 'ready',
          progress: 100,
          segmentCount: finalCount,
          totalSegments: finalCount,
          subtitles: subtitleMeta.length ? subtitleMeta : undefined,
        });
        this.events.emit({
          type: 'download.progress',
          downloadId: taskId,
          progress: 100,
        });
        this.events.emit({ type: 'download.ready', downloadId: taskId });
        this.log.log(
          `Download #${taskId}: progressive transcode complete — ${finalCount} segments, ${subtitleMeta.length} VTT subs`,
        );
      } catch (err) {
        clearInterval(monitorInterval);
        const msg = (err as Error).message;
        await this.taskRepo.update(taskId, { status: 'failed', error: msg });
        this.events.emit({
          type: 'download.failed',
          downloadId: taskId,
          error: msg,
        });
        this.log.warn(
          `Download #${taskId}: progressive transcode failed: ${msg}`,
        );
        await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
      }
    } finally {
      this.releaseSlot();
    }
  }

  /**
   * Extract each text subtitle stream as a separate .vtt file.
   * Returns array of { index, language, path } for successfully extracted subs.
   */
  private buildFullFileFfmpegArgs(
    inputPath: string,
    profile: { maxWidth: number; videoBitrate: string; audioBitrate: string },
    hwAccel: string,
    isHdr: boolean,
    subtitles: SubtitleFile[],
    resolved: ResolvedFile,
    crop?: { width: number; height: number; x: number; y: number },
    hlsConfig?: { dir: string; segmentDuration: number },
  ): string[] {
    const args: string[] = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'info',
      '-threads',
      '4',
      '-filter_threads',
      '1',
    ];

    // Hardware acceleration input
    const effectiveHw =
      crop && (hwAccel === 'qsv' || hwAccel === 'vaapi') ? 'vaapi' : hwAccel;
    switch (effectiveHw) {
      case 'qsv':
        args.push(
          '-init_hw_device',
          'vaapi=va:/dev/dri/renderD128',
          '-init_hw_device',
          'qsv=qs@va',
          '-hwaccel',
          'vaapi',
          '-hwaccel_output_format',
          'vaapi',
          '-hwaccel_device',
          'va',
        );
        if (isHdr)
          args.push(
            '-init_hw_device',
            'opencl=ocl:0.0',
            '-filter_hw_device',
            'ocl',
          );
        break;
      case 'vaapi':
        args.push(
          '-init_hw_device',
          'vaapi=va:/dev/dri/renderD128',
          '-hwaccel',
          'vaapi',
          '-hwaccel_output_format',
          'vaapi',
          '-hwaccel_device',
          'va',
        );
        if (isHdr)
          args.push(
            '-init_hw_device',
            'opencl=ocl:0.0',
            '-filter_hw_device',
            'ocl',
          );
        break;
      case 'nvenc':
        args.push('-hwaccel', 'cuda');
        if (!isHdr && !crop) args.push('-hwaccel_output_format', 'cuda');
        break;
    }

    args.push('-i', inputPath);

    // External subtitle file inputs
    const extSubs = subtitles.filter((s) => s.relativePath);
    for (const sub of extSubs) {
      args.push('-i', path.resolve(resolved.media.path!, sub.relativePath!));
    }

    // Video filter chain
    const w = profile.maxWidth;
    const cropF = crop
      ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},`
      : '';
    const hwCrop = crop
      ? `hwdownload,format=nv12,${cropF}hwupload=derive_device=vaapi,`
      : '';

    switch (effectiveHw) {
      case 'qsv':
        args.push('-c:v', 'h264_qsv');
        if (isHdr) {
          args.push(
            '-vf',
            `scale_vaapi=w=${w}:h=-16:extra_hw_frames=24,hwmap=derive_device=opencl:mode=read,tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=reinhard:desat=0,hwmap=derive_device=qsv:mode=write:reverse=1:extra_hw_frames=16,format=qsv`,
          );
        } else {
          args.push(
            '-vf',
            `scale_vaapi=w=${w}:h=-16:format=nv12:extra_hw_frames=24,hwmap=derive_device=qsv,format=qsv`,
          );
        }
        break;
      case 'vaapi':
        args.push('-c:v', 'h264_vaapi');
        if (isHdr) {
          args.push(
            '-vf',
            `${hwCrop}scale_vaapi=w=${w}:h=-16:extra_hw_frames=24,hwmap=derive_device=opencl:mode=read,tonemap_opencl=format=nv12:p=bt709:t=bt709:m=bt709:tonemap=reinhard:desat=0,hwmap=derive_device=vaapi:mode=write:reverse=1,format=vaapi`,
          );
        } else if (crop) {
          args.push('-vf', `${hwCrop}scale_vaapi=w=${w}:h=-16:format=nv12`);
        } else {
          args.push('-vf', `scale_vaapi=w=${w}:h=-16:format=nv12`);
        }
        break;
      case 'nvenc':
        args.push('-c:v', 'h264_nvenc', '-preset', 'p4');
        if (isHdr) {
          args.push(
            '-vf',
            `hwdownload,format=p010le,${cropF}zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=mobius:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,scale=${w}:-2`,
          );
        } else if (crop) {
          args.push(
            '-vf',
            `hwdownload,format=nv12,${cropF}scale=${w}:-2,format=yuv420p`,
          );
        } else {
          args.push('-vf', `scale_cuda=w=${w}:h=-2:format=nv12`);
        }
        break;
      default: // CPU
        args.push('-c:v', 'libx264', '-preset', 'veryfast');
        if (isHdr) {
          args.push(
            '-vf',
            `${cropF}zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=mobius:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,scale=${w}:-2:flags=lanczos`,
          );
        } else {
          args.push(
            '-vf',
            `${cropF}scale=${w}:-2:flags=lanczos,format=yuv420p`,
          );
        }
    }

    // Rate control: cap VBV buffer to prevent unbounded memory growth on long encodes
    const bufsize = `${parseInt(profile.videoBitrate) * 2}${profile.videoBitrate.replace(/[0-9.]/g, '')}`;
    args.push(
      '-b:v',
      profile.videoBitrate,
      '-maxrate',
      profile.videoBitrate,
      '-bufsize',
      bufsize,
    );

    // Map video + ALL audio tracks (multi-language offline playback).
    // Each audio track → AAC. Language metadata preserved so players expose
    // track names (ExoPlayer, AVPlayer, Shaka).
    const audioStreams: { language?: string }[] =
      resolved.mediaFile.streamInfo?.audio ?? [];
    args.push('-map', '0:v:0');
    if (audioStreams.length > 1) {
      for (let i = 0; i < audioStreams.length; i++) {
        args.push('-map', `0:a:${i}`);
        const lang = audioStreams[i].language;
        if (lang) args.push(`-metadata:s:a:${i}`, `language=${lang}`);
      }
    } else {
      args.push('-map', '0:a');
    }
    // Copy audio as-is — no re-encode, keep original codec (EAC3/AC3/AAC/etc.)
    // and channel layout (5.1/7.1/stereo). All modern players handle these in fMP4.
    args.push('-c:a', 'copy');

    // Limit muxer packet queue — prevents unbounded memory growth during full-file encodes
    args.push('-max_muxing_queue_size', '4096');

    if (hlsConfig) {
      // HLS fMP4 output for progressive downloads — subtitles extracted
      // separately as VTT, so no embedded subs in HLS.
      args.push(
        '-f',
        'hls',
        '-hls_time',
        String(hlsConfig.segmentDuration),
        '-hls_list_size',
        '0',
        '-start_number',
        '0',
        '-hls_segment_type',
        'fmp4',
        '-hls_fmp4_init_filename',
        'init.mp4',
        '-hls_flags',
        'independent_segments',
        '-hls_segment_filename',
        path.join(hlsConfig.dir, 'seg-%04d.m4s'),
        path.join(hlsConfig.dir, 'index.m3u8'),
      );
    }
    return args;
  }

  private async extractSubtitlesAsVtt(
    inputPath: string,
    taskId: number,
    subtitles: {
      streamIndex: number;
      codec: string;
      language: string;
      forced: boolean;
    }[],
  ): Promise<
    { index: number; language: string; forced: boolean; path: string }[]
  > {
    const textSubs = subtitles.filter((s) => !BITMAP_SUB_CODECS.has(s.codec));
    if (!textSubs.length) return [];

    const results: {
      index: number;
      language: string;
      forced: boolean;
      path: string;
    }[] = [];
    for (const sub of textSubs) {
      const vttPath = path.join(
        this.cachePath,
        `dl-${taskId}-sub-${sub.streamIndex}.vtt`,
      );
      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn(
            'ffmpeg',
            [
              '-y',
              '-hide_banner',
              '-loglevel',
              'error',
              '-i',
              inputPath,
              '-map',
              `0:${sub.streamIndex}`,
              '-c:s',
              'webvtt',
              vttPath,
            ],
            { stdio: ['ignore', 'ignore', 'pipe'] },
          );
          let err = '';
          proc.stderr.on('data', (c: Buffer) => {
            err += c.toString();
          });
          proc.on('close', (code) =>
            code === 0 ? resolve() : reject(new Error(err || `exit ${code}`)),
          );
          proc.on('error', reject);
        });
        results.push({
          index: sub.streamIndex,
          language: sub.language,
          forced: sub.forced,
          path: vttPath,
        });
      } catch (e) {
        this.log.warn(
          `Download #${taskId}: failed to extract sub stream ${sub.streamIndex}: ${(e as Error).message}`,
        );
      }
    }
    this.log.log(
      `Download #${taskId}: extracted ${results.length}/${textSubs.length} subtitle tracks as VTT`,
    );
    return results;
  }

  private parseBitrate(s: string): number {
    const match = s.match(/^(\d+(?:\.\d+)?)\s*(k|m)?$/i);
    if (!match) return 0;
    const n = parseFloat(match[1]);
    const unit = (match[2] ?? '').toLowerCase();
    if (unit === 'k') return n * 1000;
    if (unit === 'm') return n * 1_000_000;
    return n;
  }

  private formatSize(bytes: number): string {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
    return `${(bytes / 1e3).toFixed(0)} KB`;
  }
}
