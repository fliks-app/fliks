import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SubtitleFile } from './entities/subtitle-file.entity';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { SubtitleProviderType, SubtitleStatus } from '../../common/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsService } from '../scheduler/events.service';
import { EngineService } from '../engine/engine.service';
import { ActivityRegistryService } from '../scheduler/activity-registry.service';
import { resolveSubtitleAbsolutePath } from './subtitle-path.util';
import {
  buildMediaProgressSubject,
  type MediaProgressSubject,
} from '../../common/utils/media-progress-subject.util';

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
  /** Set by the scheduler for unattended runs — tells the client to skip the toast */
  automatic?: boolean;
}

export interface SyncQueueItem {
  subtitleId: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  error?: string;
  queuedAt: number;
  startedAt?: number;
  completedAt?: number;
  subject: MediaProgressSubject;
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
    private readonly engine: EngineService,
    private readonly events: EventsService,
    private readonly activityRegistry: ActivityRegistryService,
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
    const subtitle = await this.repo.findOne({
      where: { id },
      relations: ['media', 'episode', 'episode.season'],
    });
    if (!subtitle) throw new NotFoundException(`SubtitleFile #${id} not found`);
    if (subtitle.providerType === SubtitleProviderType.EMBEDDED) {
      throw new BadRequestException('Cannot sync an embedded subtitle');
    }

    // Mark as locked since this is a manual action
    subtitle.locked = true;
    await this.repo.save(subtitle);

    // Don't queue duplicates
    const existing = this.queue.find(
      (q) =>
        q.subtitleId === id &&
        (q.status === 'queued' || q.status === 'running'),
    );
    if (existing) return existing;

    const subject = buildMediaProgressSubject(
      subtitle.media,
      subtitle.episode
        ? {
            id: subtitle.episode.id,
            seasonNumber: subtitle.episode.season?.seasonNumber,
            episodeNumber: subtitle.episode.episodeNumber,
            title: subtitle.episode.title,
          }
        : null,
    );
    const item: SyncQueueItem = {
      subtitleId: id,
      status: 'queued',
      queuedAt: Date.now(),
      subject,
    };
    this.queue.push(item);
    this.activityRegistry.upsertPending(
      `SubtitleSync:${id}`,
      'SubtitleSync',
      subject,
    );
    this.logger.log(
      `Sync queued for subtitle #${id} (queue size: ${this.queue.filter((q) => q.status === 'queued').length})`,
    );

    // Trim old completed/failed entries (keep last 50)
    while (
      this.queue.length > 50 &&
      (this.queue[0].status === 'completed' ||
        this.queue[0].status === 'failed')
    ) {
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
    this.activityRegistry.upsertRunning(
      `SubtitleSync:${next.subtitleId}`,
      'SubtitleSync',
      next.subject,
    );
    this.logger.log(`Sync starting for subtitle #${next.subtitleId}`);

    try {
      await this.doSync(next.subtitleId, options);
      next.status = 'completed';
      const durationSec = ((Date.now() - next.startedAt) / 1000).toFixed(1);
      this.logger.log(
        `Sync completed for subtitle #${next.subtitleId} in ${durationSec}s`,
      );
    } catch (err) {
      next.status = 'failed';
      next.error = (err as Error).message;
      this.logger.warn(
        `Sync failed for subtitle #${next.subtitleId}: ${next.error}`,
      );
    } finally {
      next.completedAt = Date.now();
      this.running--;
      this.activityRegistry.remove(`SubtitleSync:${next.subtitleId}`);
      void this.processQueue(options);
    }
  }

  /** Direct sync, called from the scheduler queue or the manual-sync endpoint. */
  async syncSubtitle(
    id: number,
    options: SyncOptions = {},
  ): Promise<SubtitleFile> {
    return this.doSync(id, options);
  }

  private async doSync(
    id: number,
    options: SyncOptions,
  ): Promise<SubtitleFile> {
    const subtitle = await this.repo.findOne({ where: { id } });
    if (!subtitle) throw new NotFoundException(`SubtitleFile #${id} not found`);
    if (subtitle.providerType === SubtitleProviderType.EMBEDDED) {
      throw new BadRequestException('Cannot sync an embedded subtitle');
    }

    const mediaFile = await this.mediaFileRepo.findOne({
      where: { id: subtitle.mediaFileId },
    });
    if (!mediaFile) {
      throw new NotFoundException(`MediaFile #${subtitle.mediaFileId} not found`);
    }
    const info = mediaFile.streamInfo;
    if (!info) {
      throw new Error('No probe data for this file; rescan the media first');
    }

    const mediaForSub = await this.mediaRepo.findOne({
      where: { id: subtitle.mediaId },
      relations: ['library'],
    });
    if (!mediaForSub?.path) {
      throw new NotFoundException(
        `Media #${subtitle.mediaId} not found or has no root path`,
      );
    }
    const subPath = resolveSubtitleAbsolutePath(
      mediaForSub.path,
      subtitle.relativePath,
    );
    if (!subPath) {
      throw new BadRequestException(
        'Subtitle has no resolvable file path (check media root folder and relative path)',
      );
    }
    const mediaFilePath = path.join(mediaForSub.path, mediaFile.relativePath);

    const format = subtitleFormat(subPath);
    const text = await fs.readFile(subPath, 'utf-8');
    const reference = syncReference(options.reference, mediaForSub.path);

    // A fresh attempt owns the outcome: a success below has to clear what the
    // last failure recorded.
    subtitle.syncFailed = false;
    subtitle.errorMessage = null;

    try {
      const result = await this.engine.runJob({
        kind: {
          type: 'SubtitleSync',
          info,
          subtitle: { format, text },
          reference,
          maxOffsetSeconds: options.maxOffsetSeconds,
          noFixFramerate: options.noFixFramerate,
          gss: options.goldenSectionSearch,
        },
        media: { mediaFileId: mediaFile.id, path: mediaFilePath },
        priority: options.automatic ? 'low' : 'high',
      });
      await fs.writeFile(subPath, result.subtitle.text, 'utf-8');
      subtitle.synced = true;
      subtitle.status = SubtitleStatus.SYNCED;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(`Subtitle sync failed for #${id}: ${detail}`);
      // Saved before the throw: the caller only reports the failure to the
      // in-memory sync queue, which no page outlives.
      subtitle.syncFailed = true;
      subtitle.errorMessage = detail.slice(0, 2000);
      await this.repo.save(subtitle);
      throw new Error(`Sync failed: ${detail}`);
    }

    const saved = await this.repo.save(subtitle);

    if (saved.synced) {
      void this.notifications.dispatch('subtitle.synced', {
        language: saved.language,
        subtitleId: saved.id,
      });
      this.events.emit({
        type: 'subtitle.synced',
        subtitleId: saved.id,
        language: saved.language,
        mediaId: saved.mediaId,
        automatic: options.automatic,
      });
    }

    return saved;
  }

  async reencodeToUtf8(id: number): Promise<void> {
    const subtitle = await this.repo.findOne({ where: { id } });
    if (!subtitle) throw new NotFoundException(`SubtitleFile #${id} not found`);
    if (!subtitle.relativePath) return;

    const media = await this.mediaRepo.findOne({
      where: { id: subtitle.mediaId },
      relations: ['library'],
    });
    const abs = resolveSubtitleAbsolutePath(
      media?.path ?? null,
      subtitle.relativePath,
    );
    if (!abs) return;

    const buffer = await fs.readFile(abs);
    const content = buffer.toString('utf-8');
    await fs.writeFile(abs, content, 'utf-8');
  }
}

const SUBTITLE_FORMATS = ['srt', 'sub', 'ass', 'ssa', 'vtt'] as const;
type SidecarFormat = (typeof SUBTITLE_FORMATS)[number];

function subtitleFormat(filePath: string): SidecarFormat {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if ((SUBTITLE_FORMATS as readonly string[]).includes(ext)) {
    return ext as SidecarFormat;
  }
  throw new BadRequestException(`Cannot sync a .${ext || 'unknown'} subtitle`);
}

function syncReference(reference: string | undefined, mediaRoot: string) {
  if (!reference || reference === 'auto') return { type: 'auto' as const };
  const stream = /^(audio|subtitle):(\d+)$/.exec(reference);
  if (stream) {
    const index = Number(stream[2]);
    return stream[1] === 'audio'
      ? { type: 'audioStream' as const, index }
      : { type: 'subtitleStream' as const, index };
  }
  const raw = /^file:(.+)$/.exec(reference)?.[1] ?? reference;
  const abs = path.isAbsolute(raw)
    ? raw
    : resolveSubtitleAbsolutePath(mediaRoot, raw);
  if (!abs) {
    throw new BadRequestException(`Invalid reference subtitle path: ${raw}`);
  }
  return { type: 'file' as const, path: abs };
}
