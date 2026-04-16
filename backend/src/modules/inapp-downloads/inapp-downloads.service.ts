import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DownloadTask } from './entities/download-task.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { Episode } from '../media/entities/episode.entity';
import { Media } from '../media/entities/media.entity';
import { User } from '../users/entities/user.entity';
import { StreamingService } from '../streaming/streaming.service';
import { PROFILES } from '../streaming/transcoding.service';

export interface DownloadQuality {
  key: string;
  label: string;
  estimatedSize: number;
}

/**
 * Simplified in-app downloads service.
 *
 * Clients download via the streaming endpoint (`/api/stream/{mfid}/master.m3u8`)
 * using native platform APIs (Shaka offline for web, ExoPlayer for Android,
 * AVFoundation for iOS). This service only tracks task metadata.
 *
 * Flow:
 *   1. POST /api/downloads → create task with status 'transcoding'
 *   2. Client downloads via streaming endpoint (TranscodingService handles FFmpeg)
 *   3. Client → POST /api/downloads/:id/ack → marks downloaded
 *   4. DELETE → cancel
 */
@Injectable()
export class InappDownloadsService implements OnModuleInit {
  private readonly log = new Logger(InappDownloadsService.name);

  constructor(
    @InjectRepository(DownloadTask)
    private readonly taskRepo: Repository<DownloadTask>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    private readonly streaming: StreamingService,
  ) {}

  async onModuleInit() {
    // Mark any in-progress tasks as failed (server restarted)
    const stale = await this.taskRepo.find({
      where: [
        { status: 'transcoding' },
        { status: 'pending' },
      ],
    });
    if (stale.length) {
      await this.taskRepo.update(
        stale.map((t) => t.id),
        {
          status: 'failed',
          error: 'Server restarted during processing',
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
      videoCodecs?: string[];
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
      status: 'transcoding',
      episodeLabel,
    });
    const saved = await this.taskRepo.save(task);
    this.log.log(`Download #${saved.id}: created (streaming endpoint handles transcoding)`);
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
      videoCodecs?: string[];
      maxAudioChannels?: number;
    },
  ): Promise<DownloadTask> {
    const task = await this.getOne(userId, taskId);
    if (task.status !== 'failed' && task.status !== 'expired') {
      throw new BadRequestException(
        'Only failed or expired downloads can be retried',
      );
    }

    // Reset task state
    await this.taskRepo.update(task.id, {
      status: 'transcoding',
      progress: 0,
      error: undefined,
      clientDownloadedAt: undefined,
    });

    return this.getOne(userId, taskId);
  }

  async ackDownloaded(userId: number, taskId: number): Promise<void> {
    const task = await this.getOne(userId, taskId);
    await this.taskRepo.update(task.id, { clientDownloadedAt: new Date() });
  }

  /** Expire old unacked tasks */
  async cleanupStaleFiles(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const stale = await this.taskRepo
      .createQueryBuilder('t')
      .where('t.status = :status', { status: 'ready' })
      .andWhere('t."clientDownloadedAt" IS NULL')
      .andWhere('t."updatedAt" < :cutoff', { cutoff })
      .getMany();

    if (stale.length) {
      for (const task of stale) {
        await this.taskRepo.update(task.id, {
          status: 'expired',
          error: 'File expired — client never downloaded',
        });
      }
      this.log.log(`Cleanup: expired ${stale.length} stale download tasks`);
    }
    return stale.length;
  }

  async delete(userId: number, taskId: number): Promise<void> {
    const task = await this.getOne(userId, taskId);
    await this.taskRepo.remove(task);
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
