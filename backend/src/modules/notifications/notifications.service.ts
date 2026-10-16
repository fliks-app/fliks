import { Injectable, Logger } from '@nestjs/common';
import { bridgeFetch } from '../bridge/server-bridge';
import type { NotificationEvent } from './entities/notification-connection.entity';

/** Client of fliks-server's `POST /internal/notifications/dispatch`, which owns connections, senders and formatting. */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  /** Fire-and-forget callers: resolves once every sender settled, never rejects. */
  async dispatch(
    event: NotificationEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.dispatchStrict(event, payload);
    } catch (e) {
      this.log.warn(`Notification dispatch failed: ${(e as Error).message}`);
    }
  }

  /** Awaited callers (plugin host): a failure reaches them. */
  async dispatchStrict(
    event: NotificationEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await bridgeFetch('/internal/notifications/dispatch', {
      method: 'POST',
      body: { event, payload },
      // Senders have a 10 s timeout each and run concurrently.
      signal: AbortSignal.timeout(15_000),
    });
  }
}
