import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as path from 'path';
import { MediaFile } from '../../modules/media/entities/media-file.entity';
import { MediaRescanService } from '../../modules/media/media-service/media-rescan.service';
import { SubtitleSchedulerService } from '../../modules/scheduler/subtitle-scheduler.service';
import { EventsService } from '../../modules/scheduler/events.service';
import { ActivityRegistryService } from '../../modules/scheduler/activity-registry.service';
import {
  buildMediaProgressSubject,
  formatMediaProgressSubject,
  type MediaProgressSubject,
} from '../utils/media-progress-subject.util';

const ENRICH_CONCURRENCY = 1;

/** SSE task key the client's import banner reads. */
export const POST_IMPORT_PROGRESS = 'PostImportEnrich';

export interface PostImportTask {
  mediaFileId: number;
}

/** FIFO queue for post-import enrichment (crop, osdb hash, subtitle cache +
 *  search), bounds ffmpeg concurrency so a library batch can't pile up. */
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
  private subject: MediaProgressSubject | null = null;

  constructor(
    @InjectRepository(MediaFile)
    private readonly fileRepo: Repository<MediaFile>,
    @Inject(forwardRef(() => MediaRescanService))
    private readonly mediaRescan: MediaRescanService,
    @Inject(forwardRef(() => SubtitleSchedulerService))
    private readonly subtitleScheduler: SubtitleSchedulerService,
    private readonly events: EventsService,
    private readonly activityRegistry: ActivityRegistryService,
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
    this.activityRegistry.upsertPending(
      `PostImportEnrich:${task.mediaFileId}`,
      'PostImportEnrich',
    );
    this.pump();
  }

  private emitProgress(): void {
    this.events.emit({
      type: 'task.progress',
      command: POST_IMPORT_PROGRESS,
      current: this.waveDone,
      total: this.waveTotal,
      message: this.subject ? formatMediaProgressSubject(this.subject) : '',
      subject: this.subject ?? undefined,
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
      void this.process(task)
        .catch((e) => {
          this.logger.error(
            `PostImport: unexpected failure for file #${task.mediaFileId}, ${(e as Error).message}`,
          );
        })
        .finally(() => {
          this.active--;
          this.queued.delete(task.mediaFileId);
          this.activityRegistry.remove(`PostImportEnrich:${task.mediaFileId}`);
          this.waveDone++;
          if (this.active === 0 && this.tasks.length === 0) {
            this.subject = null;
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
    let file: MediaFile | null;
    try {
      file = await this.fileRepo.findOne({
        where: { id: mediaFileId },
        relations: ['media', 'episode', 'episode.season'],
      });
    } catch (e) {
      this.logger.error(
        `PostImport: failed to load file #${mediaFileId}, ${(e as Error).message}`,
      );
      return;
    }
    const normPath = file?.relativePath?.replace(/\\/g, '/');
    if (!file?.media?.path || !normPath) {
      this.logger.warn(
        `PostImport: file #${mediaFileId} missing or media has no path`,
      );
      return;
    }
    const absPath = path.join(path.resolve(file.media.path), normPath);
    const ep = file.episode;
    this.subject = buildMediaProgressSubject(
      file.media,
      ep
        ? {
            seasonNumber: ep.season?.seasonNumber,
            episodeNumber: ep.episodeNumber,
            title: ep.title,
          }
        : null,
    );
    this.emitProgress();
    this.activityRegistry.upsertRunning(
      `PostImportEnrich:${mediaFileId}`,
      'PostImportEnrich',
      this.subject,
    );

    try {
      await this.mediaRescan.finalizeImportedFile(file, absPath, file.media);
    } catch (e) {
      this.logger.warn(
        `PostImport: enrichment failed for file #${mediaFileId}, ${(e as Error).message}`,
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
        `PostImport: subtitle pipeline failed for file #${mediaFileId}, ${(e as Error).message}`,
      );
    }
  }
}
