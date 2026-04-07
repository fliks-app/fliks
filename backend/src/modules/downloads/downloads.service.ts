import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DownloadTask } from './entities/download-task.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { Episode } from '../media/entities/episode.entity';
import { Season } from '../media/entities/season.entity';
import { StreamingService, ResolvedFile } from '../streaming/streaming.service';
import {
  TranscodingService,
  PROFILES,
} from '../streaming/transcoding.service';
import { EventsService } from '../scheduler/events.service';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';

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
export class DownloadsService {
  private readonly log = new Logger(DownloadsService.name);
  private readonly cachePath: string;
  /** Active transcode processes — keyed by task ID */
  private readonly activeJobs = new Map<number, { kill: () => void }>();

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

  async getAvailableQualities(mediaFileId: number): Promise<DownloadQuality[]> {
    const resolved = await this.streaming.resolveFile(mediaFileId);
    const info = resolved.mediaFile.streamInfo;
    const fileSize = resolved.size;
    const video = info?.video?.[0];
    const sourceWidth = video?.width ?? 1920;
    const sourceHeight = video?.height ?? 1080;
    const sourceBitrate = info?.formatBitRate ?? 0;

    const qualities: DownloadQuality[] = [
      {
        key: 'original',
        label: `Original (${this.formatSize(fileSize)})`,
        estimatedSize: fileSize,
      },
    ];

    for (const p of PROFILES) {
      if (p.maxWidth >= sourceWidth && p.maxHeight >= sourceHeight) continue;
      const videoBps = this.parseBitrate(p.videoBitrate);
      const audioBps = this.parseBitrate(p.audioBitrate);
      const duration = info?.durationSeconds ?? 0;
      const estimated = duration > 0
        ? Math.floor(((videoBps + audioBps) * duration) / 8)
        : Math.floor(fileSize * (videoBps / Math.max(sourceBitrate, videoBps)));
      qualities.push({
        key: p.name,
        label: `${p.name} (~${this.formatSize(estimated)})`,
        estimatedSize: estimated,
      });
    }

    return qualities;
  }

  async create(
    userId: number,
    mediaFileId: number,
    quality: string,
    deviceProfile?: { supportsHdr?: boolean; audioCodecs?: string[]; maxAudioChannels?: number },
  ): Promise<DownloadTask> {
    const resolved = await this.streaming.resolveFile(mediaFileId);
    const file = resolved.mediaFile;

    // Check for existing task
    const existing = await this.taskRepo.findOne({
      where: { userId, mediaFileId, quality },
    });
    if (existing && existing.status !== 'failed') {
      return existing;
    }
    if (existing?.status === 'failed') {
      await this.taskRepo.remove(existing);
    }

    let episodeLabel: string | undefined;
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
      userId,
      mediaId: file.mediaId,
      episodeId: file.episodeId ?? undefined,
      mediaFileId,
      quality,
      status: 'pending',
      episodeLabel,
    });
    const saved = await this.taskRepo.save(task);

    const dp = deviceProfile ?? {};
    if (quality === 'original') {
      void this.runRemux(saved.id, resolved, dp);
    } else {
      void this.runTranscode(saved.id, resolved, quality, dp);
    }

    return saved;
  }

  async list(userId: number): Promise<DownloadTask[]> {
    return this.taskRepo.find({
      where: { userId },
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

  async getFilePath(userId: number, taskId: number): Promise<string> {
    const task = await this.getOne(userId, taskId);
    if (task.status !== 'ready') {
      throw new BadRequestException('Download not ready');
    }
    if (!task.outputPath) {
      throw new NotFoundException('Output file not found');
    }
    return task.outputPath;
  }

  async ackDownloaded(userId: number, taskId: number): Promise<void> {
    const task = await this.getOne(userId, taskId);
    await this.taskRepo.update(task.id, { clientDownloadedAt: new Date() });
    // Client has the file — clean up server-side transcoded file
    if (task.outputPath) {
      await fs.unlink(task.outputPath).catch(() => {});
      await this.taskRepo.update(task.id, { outputPath: undefined });
    }
  }

  /** Cleanup transcoded files older than maxAge that were never downloaded by client */
  async cleanupStaleFiles(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const stale = await this.taskRepo
      .createQueryBuilder('t')
      .where('t.status = :status', { status: 'ready' })
      .andWhere('t.outputPath IS NOT NULL')
      .andWhere('t.clientDownloadedAt IS NULL')
      .andWhere('t.updatedAt < :cutoff', { cutoff })
      .getMany();

    for (const task of stale) {
      if (task.outputPath) {
        await fs.unlink(task.outputPath).catch(() => {});
      }
      await this.taskRepo.update(task.id, {
        outputPath: undefined,
        status: 'expired',
        error: 'File expired — client never downloaded',
      });
    }
    if (stale.length) {
      this.log.log(`Cleanup: removed ${stale.length} stale transcoded files`);
    }
    return stale.length;
  }

  async delete(userId: number, taskId: number): Promise<void> {
    const task = await this.getOne(userId, taskId);
    // Kill active transcode
    this.activeJobs.get(taskId)?.kill();
    this.activeJobs.delete(taskId);
    // Remove output file
    if (task.outputPath) {
      await fs.unlink(task.outputPath).catch(() => {});
    }
    await this.taskRepo.remove(task);
  }

  /**
   * Fast remux: copy video+audio streams, convert subtitles to mov_text.
   * No re-encoding — typically takes seconds even for large files.
   */
  private async runRemux(
    taskId: number,
    resolved: ResolvedFile,
    deviceProfile: { supportsHdr?: boolean; audioCodecs?: string[]; maxAudioChannels?: number },
  ): Promise<void> {
    // If source needs video processing (HDR tonemap or crop), force full transcode
    const info = resolved.mediaFile.streamInfo;
    const video = info?.video?.[0];
    const isHdr = video?.colorSpace === 'bt2020nc' || (video?.bitDepth ?? 0) >= 10;
    const hasCrop = video && (video as any).crop;
    const needsTranscode = (isHdr && deviceProfile.supportsHdr === false) || hasCrop;
    if (needsTranscode) {
      const reasons = [
        isHdr && deviceProfile.supportsHdr === false ? 'HDR→SDR tonemap' : '',
        hasCrop ? 'crop black bars' : '',
      ].filter(Boolean).join(' + ');
      this.log.log(`Download #${taskId}: ${reasons} → full transcode`);
      const sourceHeight = video?.height ?? 1080;
      // Find profile matching source resolution (last one whose maxHeight ≤ sourceHeight, or first)
      const matchProfile = [...PROFILES].reverse().find((p) => p.maxHeight <= sourceHeight) ?? PROFILES[0];
      return this.runTranscode(taskId, resolved, matchProfile.name, deviceProfile);
    }

    await fs.mkdir(this.cachePath, { recursive: true });
    const outputFile = path.join(this.cachePath, `dl-${taskId}-remux.mp4`);
    const inputPath = resolved.absolutePath;

    // Collect external subtitles
    const subtitles = await this.subtitleRepo.find({
      where: { mediaFileId: resolved.mediaFile.id },
    });
    const extSubs = subtitles.filter((s) => s.relativePath);

    const args: string[] = ['-y', '-hide_banner', '-loglevel', 'info'];
    args.push('-i', inputPath);

    // Add external subtitle files as inputs
    for (const sub of extSubs) {
      const subPath = path.resolve(resolved.media.path!, sub.relativePath!);
      args.push('-i', subPath);
    }

    // Copy video, transcode audio to AAC for universal compatibility
    args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac', '2');

    // Map video + audio from input 0
    args.push('-map', '0:v:0', '-map', '0:a');

    // Map text-based embedded subtitle streams (skip image-based PGS/VOBSUB)
    const embeddedSubs = resolved.mediaFile.streamInfo?.subtitles ?? [];
    const textSubs = embeddedSubs.filter(
      (s) => !BITMAP_SUB_CODECS.has(s.codec),
    );
    this.log.log(
      `Download #${taskId}: embedded subs: ${embeddedSubs.length} total, ${textSubs.length} text-based, ${extSubs.length} external`,
    );
    for (const s of textSubs) {
      const idx = embeddedSubs.indexOf(s);
      args.push('-map', `0:s:${idx}`);
    }
    for (let i = 0; i < extSubs.length; i++) {
      args.push('-map', `${i + 1}:0`);
    }
    if (textSubs.length > 0 || extSubs.length > 0) {
      args.push('-c:s', 'mov_text');
    }

    args.push('-movflags', '+faststart', outputFile);

    this.log.log(`Download #${taskId}: starting remux — ffmpeg ${args.join(' ')}`);
    await this.taskRepo.update(taskId, { status: 'remuxing' });

    const duration = info?.durationSeconds ?? 0;

    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        this.activeJobs.set(taskId, { kill: () => proc.kill('SIGTERM') });

        let stderrTail = '';
        let lastPct = -1;
        proc.stderr.on('data', (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString()).slice(-2048);
          const match = stderrTail.match(/time=(\d+):(\d+):(\d+)/g);
          if (match) {
            const last = match[match.length - 1];
            const parts = last.match(/time=(\d+):(\d+):(\d+)/);
            if (parts) {
              const secs =
                parseInt(parts[1]) * 3600 +
                parseInt(parts[2]) * 60 +
                parseInt(parts[3]);
              const pct = duration > 0
                ? Math.min(99, Math.round((secs / duration) * 100))
                : 0;
              if (pct !== lastPct) {
                lastPct = pct;
                void this.taskRepo.update(taskId, { progress: pct });
                this.events.emit({
                  type: 'download.progress',
                  downloadId: taskId,
                  progress: pct,
                });
              }
            }
          }
        });

        proc.on('close', (code) => {
          this.activeJobs.delete(taskId);
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg remux exited with code ${code}`));
        });
        proc.on('error', (err) => {
          this.activeJobs.delete(taskId);
          reject(err);
        });
      });

      // Extract subtitles as separate VTT files
      const vttFiles = await this.extractSubtitlesAsVtt(
        inputPath,
        taskId,
        embeddedSubs,
      );
      const subtitleMeta = vttFiles.map((v) => ({
        language: v.language,
        forced: v.forced,
        filename: path.basename(v.path),
      }));

      const stat = await fs.stat(outputFile);
      await this.taskRepo.update(taskId, {
        status: 'ready',
        progress: 100,
        outputPath: outputFile,
        fileSize: stat.size,
        subtitles: subtitleMeta.length ? subtitleMeta : undefined,
      });
      this.events.emit({ type: 'download.ready', downloadId: taskId });
      this.log.log(`Download #${taskId}: remux complete (${this.formatSize(stat.size)}), ${subtitleMeta.length} VTT subs`);
    } catch (err) {
      const msg = (err as Error).message;
      await this.taskRepo.update(taskId, { status: 'failed', error: msg });
      this.events.emit({ type: 'download.failed', downloadId: taskId, error: msg });
      this.log.warn(`Download #${taskId}: remux failed: ${msg}`);
      await fs.unlink(outputFile).catch(() => {});
    }
  }

  private async runTranscode(
    taskId: number,
    resolved: ResolvedFile,
    quality: string,
    deviceProfile: { supportsHdr?: boolean; audioCodecs?: string[]; maxAudioChannels?: number } = {},
  ): Promise<void> {
    const profile = PROFILES.find((p) => p.name === quality);
    if (!profile) {
      await this.taskRepo.update(taskId, {
        status: 'failed',
        error: `Unknown quality: ${quality}`,
      });
      return;
    }

    await fs.mkdir(this.cachePath, { recursive: true });
    const outputFile = path.join(
      this.cachePath,
      `dl-${taskId}-${quality}.mp4`,
    );

    const inputPath = resolved.absolutePath;
    const info = resolved.mediaFile.streamInfo;
    const video = info?.video?.[0];
    const isHdr =
      video?.colorSpace === 'bt2020nc' || video?.bitDepth === 10;

    // Use detected hardware acceleration
    const hwAccel = this.transcoding.getDetectedHwAccel();

    // Collect external subtitles
    const subtitles = await this.subtitleRepo.find({
      where: { mediaFileId: resolved.mediaFile.id },
    });

    const crop = (video as any)?.crop as { width: number; height: number; x: number; y: number } | undefined;

    // Use shared builder for video+audio args, output as MP4
    const baseArgs = this.transcoding.buildFfmpegArgs(
      inputPath,
      profile,
      outputFile,
      hwAccel,
      0,     // startSegment
      isHdr,
      undefined, // burnIn
      undefined, // audioStreamIndex
      crop,
      'mp4',
    );

    // Insert subtitle inputs + mapping before the output args (-movflags +faststart output.mp4)
    // The last 3 elements are: -movflags, +faststart, outputPath
    const outputArgs = baseArgs.splice(-3);
    const args = baseArgs;

    // Add external subtitle file inputs
    const extSubs = subtitles.filter((s) => s.relativePath);
    for (const sub of extSubs) {
      const subPath = path.resolve(resolved.media.path!, sub.relativePath!);
      args.push('-i', subPath);
    }

    // Explicit mapping needed: adding subtitle -map overrides ffmpeg auto-mapping
    args.push('-map', '0:v:0', '-map', '0:a');

    // Map embedded text subtitles (skip image-based)
    const embeddedInfo = resolved.mediaFile.streamInfo;
    const embeddedSubs = embeddedInfo?.subtitles ?? [];
    const textSubs = embeddedSubs.filter(
      (s) => !BITMAP_SUB_CODECS.has(s.codec),
    );
    for (const s of textSubs) {
      const idx = embeddedSubs.indexOf(s);
      args.push('-map', `0:s:${idx}`);
    }
    // Map external subtitle files (inputs 1, 2, ...)
    for (let i = 0; i < extSubs.length; i++) {
      args.push('-map', `${i + 1}:0`);
    }
    if (textSubs.length > 0 || extSubs.length > 0) {
      args.push('-c:s', 'mov_text');
    }

    // Re-append output args
    args.push(...outputArgs);

    this.log.log(
      `Download #${taskId}: ffmpeg args: ${args.join(' ')}`,
    );
    this.log.log(
      `Download #${taskId}: starting transcode to ${quality} (${hwAccel}), embedded subs: ${(resolved.mediaFile.streamInfo?.subtitles ?? []).length}, text: ${(resolved.mediaFile.streamInfo?.subtitles ?? []).filter((s) => !BITMAP_SUB_CODECS.has(s.codec)).length}, external: ${subtitles.filter((s) => s.relativePath).length}`,
    );
    await this.taskRepo.update(taskId, { status: 'transcoding' });

    const duration = info?.durationSeconds ?? 0;
    this.log.log(`Download #${taskId}: duration=${duration}s`);

    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        this.activeJobs.set(taskId, { kill: () => proc.kill('SIGTERM') });

        let stderrTail = '';
        let lastPct = -1;
        proc.stderr.on('data', (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString()).slice(-2048);
          const match = stderrTail.match(/time=(\d+):(\d+):(\d+)/g);
          if (match) {
            const last = match[match.length - 1];
            const parts = last.match(/time=(\d+):(\d+):(\d+)/);
            if (parts) {
              const secs =
                parseInt(parts[1]) * 3600 +
                parseInt(parts[2]) * 60 +
                parseInt(parts[3]);
              const pct = duration > 0
                ? Math.min(99, Math.round((secs / duration) * 100))
                : -1; // unknown duration
              if (pct !== lastPct) {
                lastPct = pct;
                const emitPct = pct >= 0 ? pct : 0;
                void this.taskRepo.update(taskId, { progress: emitPct });
                this.events.emit({
                  type: 'download.progress',
                  downloadId: taskId,
                  progress: emitPct,
                });
              }
            }
          }
        });

        proc.on('close', (code) => {
          this.activeJobs.delete(taskId);
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg exited with code ${code}`));
        });
        proc.on('error', (err) => {
          this.activeJobs.delete(taskId);
          reject(err);
        });
      });

      // Extract subtitles as separate VTT files
      const embeddedSubs = resolved.mediaFile.streamInfo?.subtitles ?? [];
      const vttFiles = await this.extractSubtitlesAsVtt(
        resolved.absolutePath,
        taskId,
        embeddedSubs,
      );
      const subtitleMeta = vttFiles.map((v) => ({
        language: v.language,
        forced: v.forced,
        filename: path.basename(v.path),
      }));

      const stat = await fs.stat(outputFile);
      await this.taskRepo.update(taskId, {
        status: 'ready',
        progress: 100,
        outputPath: outputFile,
        fileSize: stat.size,
        subtitles: subtitleMeta.length ? subtitleMeta : undefined,
      });
      this.events.emit({
        type: 'download.ready',
        downloadId: taskId,
      });
      this.log.log(`Download #${taskId}: transcode complete (${this.formatSize(stat.size)}), ${subtitleMeta.length} VTT subs`);
    } catch (err) {
      const msg = (err as Error).message;
      await this.taskRepo.update(taskId, {
        status: 'failed',
        error: msg,
      });
      this.events.emit({
        type: 'download.failed',
        downloadId: taskId,
        error: msg,
      });
      this.log.warn(`Download #${taskId}: transcode failed: ${msg}`);
      await fs.unlink(outputFile).catch(() => {});
    }
  }


  /**
   * Extract each text subtitle stream as a separate .vtt file.
   * Returns array of { index, language, path } for successfully extracted subs.
   */
  private async extractSubtitlesAsVtt(
    inputPath: string,
    taskId: number,
    subtitles: { streamIndex: number; codec: string; language: string; forced: boolean }[],
  ): Promise<{ index: number; language: string; forced: boolean; path: string }[]> {
    const textSubs = subtitles.filter((s) => !BITMAP_SUB_CODECS.has(s.codec));
    if (!textSubs.length) return [];

    const results: { index: number; language: string; forced: boolean; path: string }[] = [];
    for (const sub of textSubs) {
      const vttPath = path.join(this.cachePath, `dl-${taskId}-sub-${sub.streamIndex}.vtt`);
      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('ffmpeg', [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-i', inputPath,
            '-map', `0:${sub.streamIndex}`,
            '-c:s', 'webvtt',
            vttPath,
          ], { stdio: ['ignore', 'ignore', 'pipe'] });
          let err = '';
          proc.stderr.on('data', (c: Buffer) => { err += c.toString(); });
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(err || `exit ${code}`)));
          proc.on('error', reject);
        });
        results.push({ index: sub.streamIndex, language: sub.language, forced: sub.forced, path: vttPath });
      } catch (e) {
        this.log.warn(`Download #${taskId}: failed to extract sub stream ${sub.streamIndex}: ${(e as Error).message}`);
      }
    }
    this.log.log(`Download #${taskId}: extracted ${results.length}/${textSubs.length} subtitle tracks as VTT`);
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
