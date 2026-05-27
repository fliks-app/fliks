import { Injectable } from '@nestjs/common';
import { Subject, Observable, Subscription } from 'rxjs';
import { filter, map } from 'rxjs/operators';

export type SseEvent =
  | {
      type: 'task.progress';
      command: string;
      current: number;
      total: number;
      message: string;
    }
  | {
      type: 'subtitle.synced';
      subtitleId: number;
      language: string;
      mediaId?: number;
    }
  | {
      type: 'subtitle.downloaded';
      mediaId: number;
      title: string;
      language: string;
      provider: string;
    }
  | {
      type: 'subtitle.failed';
      mediaId: number;
      title: string;
      language: string;
      error: string;
    }
  | { type: 'import.complete'; mediaId: number; title: string }
  | { type: 'import.failed'; mediaId: number; title: string; error: string }
  | { type: 'stalled.removed'; title: string }
  | { type: 'queue.updated' }
  | { type: 'command.started'; name: string }
  | { type: 'command.completed'; name: string; status: string }
  | { type: 'rescan.started'; mediaId: number; title: string }
  | {
      type: 'rescan.completed';
      mediaId: number;
      title: string;
      added: number;
      removed: number;
      updated: number;
      subtitleRemovedMissing?: number;
      subtitleRemovedDuplicates?: number;
    }
  | { type: 'rescan.failed'; mediaId: number; title: string; error: string }
  | {
      type: 'player.command';
      mediaFileId: number;
      userId: number;
      action: 'pause' | 'play' | 'stop' | 'message';
      message?: string;
    }
  | {
      type: 'markers.season.completed';
      mediaId: number;
      seasonId: number;
      seasonNumber: number;
      introsDetected: number;
    }
  | { type: 'metadata.started'; mediaId: number; title: string }
  | { type: 'metadata.refreshed'; mediaId: number; title: string }
  | {
      type: 'metadata.failed';
      mediaId: number;
      title: string;
      error: string;
    }
  | {
      type: 'watch-history.import.started';
      serverId: number;
      serverName: string;
    }
  | {
      type: 'watch-history.import.completed';
      serverId: number;
      serverName: string;
      users: number;
      usersCreated: number;
      imported: number;
      skipped: number;
    }
  | {
      type: 'watch-history.import.failed';
      serverId: number;
      serverName: string;
      error: string;
    }
  | { type: 'seerr.import.started' }
  | {
      type: 'seerr.import.completed';
      users: number;
      usersCreated: number;
      imported: number;
      updated: number;
      skipped: number;
    }
  | { type: 'seerr.import.failed'; error: string }
  | {
      // Quick-connect pairing: emitted when a TV opens a request targeting this
      // user. Phones currently on the pending-requests page refresh on receipt
      // (filtered client-side on userId).
      type: 'pairing.requested';
      userId: number;
      pairingId: string;
      deviceName: string;
      deviceId: string;
    };

/**
 * Wraps an `SseEvent` with its delivery audience. `audience: null` is a
 * broadcast (everyone connected); a numeric array restricts the SSE push to
 * those user IDs. Backend-internal `subscribe()` listeners ignore the audience
 * and always see the event — the audience only gates the client-facing stream.
 */
interface SseEnvelope {
  audience: number[] | null;
  event: SseEvent;
}

@Injectable()
export class EventsService {
  private readonly subject = new Subject<SseEnvelope>();

  /** Broadcast to every connected client. */
  emit(event: SseEvent): void {
    this.subject.next({ audience: null, event });
  }

  /** Deliver only to the given user's SSE connections. */
  emitToUser(userId: number, event: SseEvent): void {
    this.subject.next({ audience: [userId], event });
  }

  /** Deliver only to the given users' SSE connections. Empty list = nobody. */
  emitToUsers(userIds: number[], event: SseEvent): void {
    this.subject.next({ audience: userIds, event });
  }

  getStream(userId: number): Observable<MessageEvent> {
    return this.subject.asObservable().pipe(
      filter((env) => env.audience === null || env.audience.includes(userId)),
      map((env) => ({ data: JSON.stringify(env.event) }) as MessageEvent),
    );
  }

  /** Backend-internal listener — used by services that react to other modules' events. */
  subscribe(handler: (event: SseEvent) => void): Subscription {
    return this.subject.subscribe((env) => handler(env.event));
  }
}
