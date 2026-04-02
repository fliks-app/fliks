import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SubtitleFile } from './entities/subtitle-file.entity';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { SubtitleProviderType, SubtitleStatus } from '../../common/enums';
import { NotificationsService } from '../notifications/notifications.service';

const execFileAsync = promisify(execFile);
const MAX_CONCURRENT = 2;

export interface SyncOptions {
  /** Reference track: 'auto' (default), or a path to an audio/subtitle file */
  reference?: string;
  /** Max offset in seconds (ffsubsync --max-offset-seconds) */
  maxOffsetSeconds?: number;
  /** Disable framerate correction (ffsubsync --no-fix-framerate) */
  noFixFramerate?: boolean;
  /** Use golden-section search algorithm (ffsubsync --gss) */
  goldenSectionSearch?: boolean;
}

export interface SyncQueueItem {
  subtitleId: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  error?: string;
  queuedAt: number;
  startedAt?: number;
  completedAt?: number;
}

@Injectable()
export class SubtitleSyncService {
  private readonly logger = new Logger(SubtitleSyncService.name);
  private readonly queue: SyncQueueItem[] = [];
  private running = 0;

  constructor(
    @InjectRepository(SubtitleFile)
    private readonly repo: Repository<SubtitleFile>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    private readonly notifications: NotificationsService,
  ) {}

  /** Get current queue state */
  getQueue(): SyncQueueItem[] {
    return [...this.queue];
  }

  /** Add a sync job to the queue */
  async enqueueSyncSubtitle(
    id: number,
    options: SyncOptions = {},
  ): Promise<SyncQueueItem> {
    const subtitle = await this.repo.findOne({ where: { id } });
    if (!subtitle) throw new NotFoundException(`SubtitleFile #${id} not found`);
    if (subtitle.providerType === SubtitleProviderType.EMBEDDED) {
      throw new BadRequestException('Cannot sync an embedded subtitle');
    }

    // Don't queue duplicates
    const existing = this.queue.find(
      (q) => q.subtitleId === id && (q.status === 'queued' || q.status === 'running'),
    );
    if (existing) return existing;

    const item: SyncQueueItem = {
      subtitleId: id,
      status: 'queued',
      queuedAt: Date.now(),
    };
    this.queue.push(item);

    // Trim old completed/failed entries (keep last 50)
    while (this.queue.length > 50 && (this.queue[0].status === 'completed' || this.queue[0].status === 'failed')) {
      this.queue.shift();
    }

    void this.processQueue(options);
    return item;
  }

  private async processQueue(options: SyncOptions): Promise<void> {
    if (this.running >= MAX_CONCURRENT) return;

    const next = this.queue.find((q) => q.status === 'queued');
    if (!next) return;

    this.running++;
    next.status = 'running';
    next.startedAt = Date.now();

    try {
      await this.doSync(next.subtitleId, options);
      next.status = 'completed';
    } catch (err) {
      next.status = 'failed';
      next.error = (err as Error).message;
    } finally {
      next.completedAt = Date.now();
      this.running--;
      void this.processQueue(options);
    }
  }

  /** Direct sync (called from queue or legacy) */
  async syncSubtitle(id: number, options: SyncOptions = {}): Promise<SubtitleFile> {
    return this.doSync(id, options);
  }

  private async doSync(id: number, options: SyncOptions): Promise<SubtitleFile> {
    const subtitle = await this.repo.findOne({ where: { id } });
    if (!subtitle) throw new NotFoundException(`SubtitleFile #${id} not found`);
    if (subtitle.providerType === SubtitleProviderType.EMBEDDED) {
      throw new BadRequestException('Cannot sync an embedded subtitle');
    }

    const mediaFilePath = await this.resolveMediaFilePath(
      subtitle.mediaId,
      subtitle.mediaFileId,
    );

    const subPath = subtitle.filePath!;

    // Parse reference: 'auto', 'audio:3', 'subtitle:5', or absolute path
    let refPath = mediaFilePath;
    let refStreamIndex: number | null = null;
    if (options.reference && options.reference !== 'auto') {
      const streamMatch = /^(audio|subtitle):(\d+)$/.exec(options.reference);
      if (streamMatch) {
        refStreamIndex = Number(streamMatch[2]);
      } else {
        refPath = options.reference;
      }
    }

    try {
      const args = [refPath, '-i', subPath, '-o', subPath];
      if (refStreamIndex != null) {
        args.push('--reference-stream', `stream:${refStreamIndex}`);
      }
      if (options.maxOffsetSeconds != null) {
        args.push('--max-offset-seconds', String(options.maxOffsetSeconds));
      }
      if (options.noFixFramerate) {
        args.push('--no-fix-framerate');
      }
      if (options.goldenSectionSearch) {
        args.push('--gss');
      }
      await execFileAsync('ffsubsync', args);
      subtitle.synced = true;
      subtitle.status = SubtitleStatus.SYNCED;
    } catch (err) {
      this.logger.warn(`ffsubsync failed for ${subPath}, trying alass...`);
      try {
        const alassArgs = [refPath, subPath, subPath];
        await execFileAsync('alass', alassArgs);
        subtitle.synced = true;
        subtitle.status = SubtitleStatus.SYNCED;
      } catch (alassErr) {
        this.logger.error(`Subtitle sync failed for #${id}: ${alassErr}`);
        subtitle.status = SubtitleStatus.FAILED;
        throw new Error(`Sync failed: ${(alassErr as Error).message}`);
      }
    }

    const saved = await this.repo.save(subtitle);

    if (saved.synced) {
      void this.notifications.dispatch('subtitle.synced', {
        language: saved.language,
        subtitleId: saved.id,
      });
    }

    return saved;
  }

  private async resolveMediaFilePath(
    mediaId: number,
    mediaFileId: number,
  ): Promise<string> {
    const media = await this.mediaRepo.findOne({ where: { id: mediaId } });
    if (!media?.path) {
      throw new NotFoundException(
        `Media #${mediaId} not found or has no root path`,
      );
    }
    const mediaFile = await this.mediaFileRepo.findOne({
      where: { id: mediaFileId },
    });
    if (!mediaFile) {
      throw new NotFoundException(`MediaFile #${mediaFileId} not found`);
    }
    return path.join(media.path, mediaFile.relativePath);
  }

  async reencodeToUtf8(id: number): Promise<void> {
    const subtitle = await this.repo.findOne({ where: { id } });
    if (!subtitle) throw new NotFoundException(`SubtitleFile #${id} not found`);
    if (!subtitle.filePath) return;

    const buffer = await fs.readFile(subtitle.filePath);
    const content = buffer.toString('utf-8');
    await fs.writeFile(subtitle.filePath, content, 'utf-8');
  }
}
