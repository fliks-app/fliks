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
  | { type: 'acquisition.queue.changed' };

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
    }
  }
}
