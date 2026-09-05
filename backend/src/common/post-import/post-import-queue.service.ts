import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as path from 'path';
import { MediaFile } from '../../modules/media/entities/media-file.entity';
import { MediaRescanService } from '../../modules/media/media-service/media-rescan.service';
import { SubtitleSchedulerService } from '../../modules/scheduler/subtitle-scheduler.service';
import { EventsService } from '../../modules/scheduler/events.service';

const ENRICH_CONCURRENCY = 1;

/** SSE task key the client's import banner reads. */
export const POST_IMPORT_PROGRESS = 'PostImportEnrich';

export interface PostImportTask {
  mediaFileId: number;
}

/** FIFO queue for post-import enrichment (crop, osdb hash, subtitle cache +
 *  search) — bounds ffmpeg concurrency so a library batch can't pile up. */
@Injectable()
export class PostImportQueueService {
  private readonly logger = new Logger(PostImportQueueService.name);
  private readonly queued = new Set<number>();
  private readonly tasks: PostImportTask[] = [];
  private active = 0;
  private idleWaiters: (() => void)[] = [];
  /** Counted over one drain, so the bar spans a whole import wave. Reset on idle. */
  private waveTotal = 0;
  private waveDone = 0;
  private label = '';

  constructor(
    @InjectRepository(MediaFile)
    private readonly fileRepo: Repository<MediaFile>,
    @Inject(forwardRef(() => MediaRescanService))
    private readonly mediaRescan: MediaRescanService,
    @Inject(forwardRef(() => SubtitleSchedulerService))
    private readonly subtitleScheduler: SubtitleSchedulerService,
    private readonly events: EventsService,
  ) {}

  get pendingCount(): number {
    return this.tasks.length + this.active;
  }

  /** No-op when `mediaFileId` is already queued or running. */
  enqueue(task: PostImportTask): void {
    if (this.queued.has(task.mediaFileId)) return;
    this.queued.add(task.mediaFileId);
    this.tasks.push(task);
    this.waveTotal++;
    this.emitProgress();
    this.pump();
  }

  private emitProgress(): void {
    this.events.emit({
      type: 'task.progress',
      command: POST_IMPORT_PROGRESS,
      current: this.waveDone,
      total: this.waveTotal,
      message: this.label,
    });
  }

  whenIdle(): Promise<void> {
    if (this.active === 0 && this.tasks.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    while (this.active < ENRICH_CONCURRENCY && this.tasks.length > 0) {
      const task = this.tasks.shift();
      if (!task) break;
      this.active++;
      void this.process(task).finally(() => {
        this.active--;
        this.queued.delete(task.mediaFileId);
        this.waveDone++;
        if (this.active === 0 && this.tasks.length === 0) {
          this.label = '';
          this.emitProgress();
          this.waveTotal = 0;
          this.waveDone = 0;
          const waiters = this.idleWaiters;
          this.idleWaiters = [];
          waiters.forEach((resolve) => resolve());
        } else {
          this.emitProgress();
          this.pump();
        }
      });
    }
  }

  private async process({ mediaFileId }: PostImportTask): Promise<void> {
    const file = await this.fileRepo.findOne({
      where: { id: mediaFileId },
      relations: ['media'],
    });
    const normPath = file?.relativePath?.replace(/\\/g, '/');
    if (!file?.media?.path || !normPath) {
      this.logger.warn(
        `PostImport: file #${mediaFileId} missing or media has no path`,
      );
      return;
    }
    const absPath = path.join(path.resolve(file.media.path), normPath);
    this.label = file.media.title ?? '';
    this.emitProgress();

    try {
      await this.mediaRescan.finalizeImportedFile(file, absPath, file.media);
    } catch (e) {
      this.logger.warn(
        `PostImport: enrichment failed for file #${mediaFileId} — ${(e as Error).message}`,
      );
    }
    try {
      await this.subtitleScheduler.onMediaFileImported(
        file.media.id,
        file.id,
        file.episodeId ?? undefined,
      );
    } catch (e) {
      this.logger.warn(
        `PostImport: subtitle pipeline failed for file #${mediaFileId} — ${(e as Error).message}`,
      );
    }
  }
}
