import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EventsService } from '../../modules/scheduler/events.service';
import { SseAudienceService } from '../../modules/scheduler/sse-audience.service';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { MediaServersService } from '../../modules/media-servers/media-servers.service';
import { DownloadProgressState } from '../../common/constants/download-progress-state';
import { DownloadHistory } from './entities/download-history.entity';
import { PluginCountsCacheService } from '../../modules/plugins/host/plugin-counts-cache.service';

export type AcquisitionEvent =
  | {
      type: 'acquisition.imported';
      mediaId: number;
      title: string;
      seasonNumber?: number;
      episodeNumber?: number;
      quality: string;
      sourceTitle: string;
      mediaPath: string | null;
    }
  | {
      type: 'acquisition.failed';
      mediaId: number;
      title: string;
      reason: string;
    }
  | { type: 'acquisition.queue.changed' }
  | {
      type: 'acquisition.progress';
      mediaId: number;
      mediaType: 'movie' | 'series';
      seasonNumber?: number;
      episodeNumber?: number;
      hash?: string;
      progress: number;
      dlspeed: number;
      eta: number;
      state: DownloadProgressState;
    }
  | {
      type: 'acquisition.stalled.removed';
      mediaId: number | null;
      title: string;
    };

/**
 * Fan-out for acquisition-side events: resolves the SSE audience, emits the
 * client event, and dispatches to notifications / external media servers.
 * The single seam the download bundle publishes through — it cannot resolve
 * an audience or reach a media server itself. Provided by the download
 * bundle's own module, not `FliksSchedulerModule` — core doesn't inject it.
 */
@Injectable()
export class AcquisitionEventsService implements OnModuleInit {
  constructor(
    private readonly events: EventsService,
    private readonly sseAudience: SseAudienceService,
    private readonly notifications: NotificationsService,
    private readonly mediaServers: MediaServersService,
    @InjectRepository(DownloadHistory)
    private readonly historyRepo: Repository<DownloadHistory>,
    private readonly countsCache: PluginCountsCacheService,
  ) {}

  /** Seed the badge once at startup: a progress tick deliberately does not
   *  refresh it, so without this the count stays absent until a row moves. */
  async onModuleInit(): Promise<void> {
    await this.refreshQueueCount();
  }

  private async refreshQueueCount(): Promise<void> {
    this.countsCache.set(
      'queueActive',
      await this.historyRepo.count({
        where: { status: In(['grabbed', 'importing']) },
      }),
    );
  }

  async publish(event: AcquisitionEvent): Promise<void> {
    // Every variant but a progress tick can move a row in/out of grabbed/importing,
    // so the pushed badge count is refreshed on all of them rather than tracked per-branch.
    if (event.type !== 'acquisition.progress') {
      await this.refreshQueueCount();
    }
    switch (event.type) {
      case 'acquisition.imported': {
        void this.notifications.dispatch('download.complete', {
          title: event.title,
          quality: event.quality,
          sourceTitle: event.sourceTitle,
        });
        const recipients = await this.sseAudience.recipientsForMedia(
          event.mediaId,
        );
        this.events.emitToUsers(recipients, {
          type: 'import.complete',
          mediaId: event.mediaId,
          title: event.title,
          seasonNumber: event.seasonNumber,
          episodeNumber: event.episodeNumber,
        });
        this.events.emit({ type: 'queue.updated' });
        void this.mediaServers.dispatch('download.complete', {
          title: event.title,
          path: event.mediaPath,
        });
        return;
      }
      case 'acquisition.failed': {
        const recipients = await this.sseAudience.recipientsForMedia(
          event.mediaId,
        );
        this.events.emitToUsers(recipients, {
          type: 'import.failed',
          mediaId: event.mediaId,
          title: event.title,
          error: event.reason,
        });
        this.events.emit({ type: 'queue.updated' });
        return;
      }
      case 'acquisition.queue.changed':
        this.events.emit({ type: 'queue.updated' });
        return;
      case 'acquisition.progress': {
        const recipients = await this.sseAudience.recipientsForMedia(
          event.mediaId,
        );
        if (!recipients.length) return;
        this.events.emitToUsers(recipients, {
          type: 'download.progress',
          mediaId: event.mediaId,
          mediaType: event.mediaType,
          seasonNumber: event.seasonNumber,
          episodeNumber: event.episodeNumber,
          hash: event.hash,
          progress: event.progress,
          dlspeed: event.dlspeed,
          eta: event.eta,
          state: event.state,
        });
        return;
      }
      case 'acquisition.stalled.removed': {
        const recipients = await this.sseAudience.recipientsForMedia(
          event.mediaId,
        );
        this.events.emitToUsers(recipients, {
          type: 'stalled.removed',
          title: event.title,
        });
        this.events.emit({ type: 'queue.updated' });
        return;
      }
    }
  }
}
