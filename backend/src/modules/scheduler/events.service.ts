import { Injectable, Logger } from '@nestjs/common';
import { Subject, Observable, Subscription } from 'rxjs';
import { randomUUID } from 'crypto';

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
      /** Unattended scheduler run — client skips the confirmation toast */
      automatic?: boolean;
    }
  | {
      type: 'subtitle.downloaded';
      mediaId: number;
      title: string;
      language: string;
      provider: string;
      /** Set for translation results so a client can target the finished row
       *  (e.g. add just that track) instead of a blind refetch. */
      subtitleId?: number;
      /** Unattended scheduler run — client skips the confirmation toast */
      automatic?: boolean;
    }
  | {
      type: 'subtitle.failed';
      mediaId: number;
      title: string;
      language: string;
      error: string;
      /** Set to 'rate_limit' when a translation failed on a Gemini quota/rate
       *  limit, so the client can show a specific message. */
      reason?: string;
      /** Unattended scheduler run — client skips the confirmation toast */
      automatic?: boolean;
    }
  | {
      // Machine-translation progress for a PROCESSING subtitle row. `progress`
      // is 0–100; `subtitleId` is the placeholder row the client shows.
      type: 'subtitle.translation_progress';
      subtitleId: number;
      mediaId: number;
      progress: number;
    }
  | {
      type: 'import.complete';
      mediaId: number;
      title: string;
      /** Season whose files just imported (single-season series import); unset
       *  for movies and multi-season packs. Lets the client retire just that
       *  season's live progress. */
      seasonNumber?: number;
      /** Episode whose file just imported (single-episode import); unset for
       *  movies, packs and multi-episode imports. Lets the client retire just
       *  that episode's live progress leaf, leaving sibling episodes of the
       *  same season still downloading. */
      episodeNumber?: number;
    }
  | { type: 'import.failed'; mediaId: number; title: string; error: string }
  | {
      // Live torrent progress for an in-flight grab, delivered to the media's
      // request audience. `progress` is 0–1; `state` is the raw qBittorrent
      // state (the client maps it to a label/colour). Season/episode set for
      // the matched scope of a series.
      type: 'download.progress';
      mediaId: number;
      mediaType: 'movie' | 'series';
      seasonNumber?: number;
      episodeNumber?: number;
      /** Torrent hash — disambiguates concurrent leaves of the same season when
       *  the episode relation couldn't be resolved (loose episodes with no
       *  episodeNumber would otherwise collide). */
      hash?: string;
      progress: number;
      dlspeed: number;
      eta: number;
      state: string;
    }
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
  | { type: 'media.files.delete_failed'; mediaId: number; title: string }
  | {
      // Handshake on SSE connect — tells the client which connection id to
      // bind to its live sessions so admin remote-control targets one device.
      type: 'sse.connected';
      connectionId: string;
    }
  | {
      type: 'player.command';
      sessionId: string;
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
    }
  // Social — delivered to the target user (see SocialService).
  | {
      type: 'social.followed' | 'social.follow_request' | 'social.follow_accepted';
      userId: number;
      username: string;
      avatar: string | null;
    }
  // A member recommended content to this user (see SocialService.recommend).
  | {
      type: 'social.content_recommended';
      userId: number;
      username: string;
      avatar: string | null;
      mediaTitle: string;
    };

// ---------------------------------------------------------------------------
// Domain events — backend-to-backend, distinct from the SSE bus above.
// ---------------------------------------------------------------------------

/**
 * Backend-to-backend events. Distinct from `SseEvent`, which is what browsers
 * receive: a domain event describes something that happened in the domain, and
 * its subscribers are other backend modules — eventually out-of-process plugins.
 * In-process fan-out, at-most-once, no persistence, no replay, no retry. A
 * subscriber that throws is caught and logged; it never reaches the emitter.
 */
export type DomainEvent =
  | { type: 'media.imported'; mediaId: number; tmdbId: number | null; mediaType: string; libraryId: number | null; addedByUserId: number | null }
  | { type: 'media.monitored.changed'; mediaId: number; monitored: boolean }
  | { type: 'media.season.monitored.changed'; mediaId: number; seasonNumber: number; monitored: boolean }
  | { type: 'media.removed'; mediaId: number; tmdbId: number | null; mediaType: string }
  | { type: 'media.files.imported'; mediaId: number; seasonNumber?: number; episodeNumber?: number; source: 'download' | 'disk' }
  | { type: 'media.acquisition.requested'; mediaIds: number[]; reason: string }
  // Release sent to the download client — flips matching approved requests to PROCESSING.
  | { type: 'acquisition.grabbed'; mediaId: number; seasonNumber?: number }
  | { type: 'request.created'; requestId: number; mediaType: string; tmdbId: number; userId: number | null; kind: string; seasons: number[] | null }
  | { type: 'request.approved'; requestId: number; mediaId: number | null; mediaType: string; tmdbId: number; seasons: number[] | null; approvedByUserId: number | null }
  | { type: 'library.scan.completed'; libraryId: number; added: number; updated: number }
  | { type: 'settings.changed'; key: string };

/**
 * Wraps an `SseEvent` with its delivery audience.
 *   - `audience: null` + `connectionIds: null` → every SSE connection.
 *   - `audience: [userId, …]` → every connection owned by those users.
 *   - `connectionIds: [id, …]` → only those specific SSE connections.
 * Backend-internal `subscribe()` listeners ignore the audience and always see
 * the event — the audience only gates the client-facing stream.
 */
interface SseEnvelope {
  audience: number[] | null;
  connectionIds: string[] | null;
  event: SseEvent;
}

@Injectable()
export class EventsService {
  private readonly log = new Logger(EventsService.name);
  private readonly subject = new Subject<SseEnvelope>();
  private readonly domainSubject = new Subject<DomainEvent>();
  private readonly connections = new Map<string, { userId: number }>();

  /** Broadcast to every connected client. */
  emit(event: SseEvent): void {
    this.subject.next({ audience: null, connectionIds: null, event });
  }

  /** Deliver only to the given user's SSE connections. */
  emitToUser(userId: number, event: SseEvent): void {
    this.subject.next({ audience: [userId], connectionIds: null, event });
  }

  /** Deliver only to the given users' SSE connections. Empty list = nobody. */
  emitToUsers(userIds: number[], event: SseEvent): void {
    this.subject.next({ audience: userIds, connectionIds: null, event });
  }

  /** Deliver only to one SSE connection (multi-device remote control). */
  emitToConnection(connectionId: string, event: SseEvent): void {
    if (!this.connections.has(connectionId)) return;
    this.subject.next({
      audience: null,
      connectionIds: [connectionId],
      event,
    });
  }

  hasConnection(connectionId: string): boolean {
    return this.connections.has(connectionId);
  }

  getStream(userId: number): Observable<MessageEvent> {
    return new Observable((subscriber) => {
      const connectionId = randomUUID();
      this.connections.set(connectionId, { userId });

      subscriber.next({
        data: JSON.stringify({
          type: 'sse.connected',
          connectionId,
        } satisfies SseEvent),
      } as MessageEvent);

      const sub = this.subject.subscribe((env) => {
        if (!this.shouldDeliver(env, userId, connectionId)) return;
        subscriber.next({ data: JSON.stringify(env.event) } as MessageEvent);
      });

      return () => {
        sub.unsubscribe();
        this.connections.delete(connectionId);
      };
    });
  }

  private shouldDeliver(
    env: SseEnvelope,
    userId: number,
    connectionId: string,
  ): boolean {
    if (env.audience === null && env.connectionIds === null) return true;
    if (env.connectionIds?.includes(connectionId)) return true;
    if (env.audience?.includes(userId)) return true;
    return false;
  }

  /** Backend-internal listener — used by services that react to other modules' events. */
  subscribe(handler: (event: SseEvent) => void): Subscription {
    return this.subject.subscribe((env) => handler(env.event));
  }

  /** Publish a domain event. Never throws: subscriber errors are swallowed by `onDomain`. */
  emitDomain(event: DomainEvent): void {
    this.domainSubject.next(event);
  }

  /** Subscribe to domain events. A handler that throws — or returns a rejected
   *  promise — is logged, never propagated: one bad subscriber must not reach
   *  the emitter, and an async one must not become an unhandled rejection. */
  onDomain(
    handler: (event: DomainEvent) => void | Promise<void>,
  ): Subscription {
    const fail = (event: DomainEvent, err: unknown) =>
      this.log.error(
        `Domain event handler threw on "${event.type}": ${(err as Error).message}`,
        err instanceof Error ? err.stack : undefined,
      );
    return this.domainSubject.subscribe((event) => {
      try {
        void Promise.resolve(handler(event)).catch((err) => fail(event, err));
      } catch (err) {
        fail(event, err);
      }
    });
  }
}
