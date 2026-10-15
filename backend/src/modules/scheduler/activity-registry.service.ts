import { Injectable, Logger } from '@nestjs/common';
import { bridgeConfigured, bridgeFetch } from '../bridge/server-bridge';
import type { MediaProgressSubject } from '../../common/utils/media-progress-subject.util';

type Op =
  | {
      op: 'pending';
      id: string;
      type: string;
      subject?: MediaProgressSubject;
      parentId?: string;
    }
  | {
      op: 'running';
      id: string;
      type: string;
      subject?: MediaProgressSubject;
      current?: number;
      total?: number;
      parentId?: string;
    }
  | { op: 'remove'; id: string };

/**
 * Client of the registry in fliks-server (`/internal/activity`): "what is the server doing right
 * now" lives there, next to the SSE hub that pings clients when it changes. Writes and claims are
 * queued so the registry sees them in call order.
 */
@Injectable()
export class ActivityRegistryService {
  private readonly log = new Logger(ActivityRegistryService.name);
  private sent: Promise<void> = Promise.resolve();

  upsertPending(
    id: string,
    type: string,
    subject?: MediaProgressSubject,
    parentId?: string,
  ): void {
    this.send({ op: 'pending', id, type, subject, parentId });
  }

  upsertRunning(
    id: string,
    type: string,
    subject?: MediaProgressSubject,
    current?: number,
    total?: number,
    parentId?: string,
  ): void {
    this.send({ op: 'running', id, type, subject, current, total, parentId });
  }

  remove(id: string): void {
    this.send({ op: 'remove', id });
  }

  /** Registers the work as running unless it already is, atomically in the registry: `false`
   *  means a duplicate the producer must refuse rather than run twice. */
  claim(
    id: string,
    type: string,
    subject?: MediaProgressSubject,
  ): Promise<boolean> {
    if (!bridgeConfigured()) return Promise.resolve(true);
    const claimed = this.sent.then(() =>
      bridgeFetch('/internal/activity/claim', {
        method: 'POST',
        body: { id, type, subject },
      }).then(
        () => true,
        (err: Error & { status?: number }) => {
          if (err.status === 409) return false;
          throw err;
        },
      ),
    );
    this.sent = claimed.then(
      () => undefined,
      () => undefined,
    );
    return claimed;
  }

  private send(body: Op): void {
    if (!bridgeConfigured()) return;
    this.sent = this.sent
      .then(() => bridgeFetch('/internal/activity', { method: 'POST', body }))
      .then(
        () => undefined,
        (err: Error) =>
          this.log.error(
            `Activity ${body.op} "${body.id}" not delivered: ${err.message}`,
          ),
      );
  }
}
