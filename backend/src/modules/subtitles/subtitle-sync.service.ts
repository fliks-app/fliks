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
import { FfprobeService } from './ffprobe.service';
import { EventsService } from '../scheduler/events.service';
import { MediaServersService } from '../media-servers/media-servers.service';
import { resolveSubtitleAbsolutePath } from './subtitle-path.util';

const execFileAsync = promisify(execFile);
const SYNC_TOOL_TIMEOUT_MS = 900_000;
const SYNC_TOOL_MAX_BUFFER = 1 << 24;
const SYNC_EXEC_OPTS = {
  timeout: SYNC_TOOL_TIMEOUT_MS,
  maxBuffer: SYNC_TOOL_MAX_BUFFER,
};
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
    private readonly ffprobe: FfprobeService,
    private readonly events: EventsService,
    private readonly mediaServers: MediaServersService,
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

    const item: SyncQueueItem = {
      subtitleId: id,
      status: 'queued',
      queuedAt: Date.now(),
    };
    this.queue.push(item);
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

    const mediaFilePath = await this.resolveMediaFilePath(
      subtitle.mediaId,
      subtitle.mediaFileId,
    );

    const mediaForSub = await this.mediaRepo.findOne({
      where: { id: subtitle.mediaId },
      relations: ['library'],
    });
    const subPath = resolveSubtitleAbsolutePath(
      mediaForSub?.path ?? null,
      subtitle.relativePath,
    );
    if (!subPath) {
      throw new BadRequestException(
        'Subtitle has no resolvable file path (check media root folder and relative path)',
      );
    }

    // Parse reference: 'auto', 'audio:3', 'subtitle:5', 'file:/path/to/sub.srt', or absolute path
    let refPath = mediaFilePath;
    let refStreamIndex: number | null = null;
    if (options.reference && options.reference !== 'auto') {
      const streamMatch = /^(audio|subtitle):(\d+)$/.exec(options.reference);
      const fileMatch = /^file:(.+)$/.exec(options.reference);
      if (streamMatch) {
        refStreamIndex = Number(streamMatch[2]);
      } else if (fileMatch) {
        const raw = fileMatch[1];
        if (path.isAbsolute(raw)) {
          refPath = raw;
        } else {
          const abs = resolveSubtitleAbsolutePath(
            mediaForSub?.path ?? null,
            raw,
          );
          if (!abs) {
            throw new BadRequestException(
              `Invalid reference subtitle path: ${raw}`,
            );
          }
          refPath = abs;
        }
      } else {
        refPath = options.reference;
      }
    }

    const buildFfsubsyncArgs = (ref: string, streamIdx: number | null) => {
      const args = [ref, '-i', subPath, '-o', subPath];
      if (streamIdx != null) {
        args.push('--reference-stream', `stream:${streamIdx}`);
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
      return args;
    };

    try {
      await execFileAsync(
        'ffsubsync',
        buildFfsubsyncArgs(refPath, refStreamIndex),
        SYNC_EXEC_OPTS,
      );
      subtitle.synced = true;
      subtitle.status = SubtitleStatus.SYNCED;
    } catch (err: any) {
      this.logger.warn(
        `ffsubsync failed for ${subPath}: ${err.stderr || err.message || err}`,
      );

      // If auto mode failed with "Unable to detect speech", retry with first audio stream
      if (
        refStreamIndex == null &&
        /unable to detect speech/i.test(err.stderr || '')
      ) {
        const streams = await this.ffprobe.detectStreams(mediaFilePath);
        const firstAudio = streams.find((s) => s.type === 'audio');
        if (firstAudio) {
          this.logger.log(
            `Retrying ffsubsync with explicit audio stream:${firstAudio.streamIndex}`,
          );
          try {
            await execFileAsync(
              'ffsubsync',
              buildFfsubsyncArgs(refPath, firstAudio.streamIndex),
              SYNC_EXEC_OPTS,
            );
            subtitle.synced = true;
            subtitle.status = SubtitleStatus.SYNCED;
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
          } catch (retryErr: any) {
            this.logger.warn(
              `ffsubsync retry also failed: ${retryErr.stderr || retryErr.message}`,
            );
          }
        }
      }

      // Fallback to alass
      try {
        await execFileAsync('alass', [refPath, subPath, subPath], SYNC_EXEC_OPTS);
        subtitle.synced = true;
        subtitle.status = SubtitleStatus.SYNCED;
      } catch (alassErr: any) {
        this.logger.error(
          `Subtitle sync failed for #${id}:\n  ffsubsync stderr: ${err.stderr || '(none)'}\n  alass stderr: ${alassErr.stderr || '(none)'}\n  alass stdout: ${alassErr.stdout || '(none)'}\n  alass message: ${alassErr.message || alassErr}`,
        );
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
      this.events.emit({
        type: 'subtitle.synced',
        subtitleId: saved.id,
        language: saved.language,
        mediaId: saved.mediaId,
        automatic: options.automatic,
      });
      // Notify media servers (Emby/Plex) to refresh
      const media = await this.mediaRepo.findOne({
        where: { id: saved.mediaId },
      });
      if (media) {
        void this.mediaServers.dispatch('subtitle.synced', {
          title: media.title,
          path: media.path,
        });
      }
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
