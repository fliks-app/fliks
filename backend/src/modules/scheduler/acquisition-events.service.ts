import { Injectable } from '@nestjs/common';
import { EventsService } from './events.service';
import { SseAudienceService } from './sse-audience.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MediaServersService } from '../media-servers/media-servers.service';

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
  | { type: 'acquisition.failed'; mediaId: number; title: string; reason: string }
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
      state: string;
    }
  | {
      type: 'acquisition.stalled.removed';
      mediaId: number | null;
      title: string;
    };

/**
 * Fan-out for acquisition-side events: resolves the SSE audience, emits the
 * client event, and dispatches to notifications / external media servers.
 * The single seam a download plugin will publish through — it cannot resolve
 * an audience or reach a media server itself.
 */
@Injectable()
export class AcquisitionEventsService {
  constructor(
    private readonly events: EventsService,
    private readonly sseAudience: SseAudienceService,
    private readonly notifications: NotificationsService,
    private readonly mediaServers: MediaServersService,
  ) {}

  async publish(event: AcquisitionEvent): Promise<void> {
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
