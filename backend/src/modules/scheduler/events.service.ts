import { Injectable, Logger } from '@nestjs/common';
import { Subject, Observable, Subscription } from 'rxjs';
import { randomUUID } from 'crypto';
import { DownloadProgressState } from '../../common/constants/download-progress-state';
import { DownloadProgressCacheService } from './download-progress-cache.service';

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
      // A media's subtitle list gained or lost a row without any client having asked for it:
      // an import storing embedded tracks, an OCR run creating its PROCESSING placeholder.
      // Carries no title and raises no toast — it exists so the list stops being stale.
      type: 'subtitle.list_changed';
      mediaId: number;
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
      /**
       * Every download in flight for this media, delivered to its request audience. A
       * replacement, never a delta: whatever is absent has been retired, and an empty array
       * retires the media. A per-download event could not say that, so a consumer had to infer
       * a removal from a compensating event or a timeout.
       */
      type: 'download.progress';
      mediaId: number;
      mediaType: 'movie' | 'series';
      downloads: {
        /** Opaque per-download identity, straight from `progress.set`'s `ref`. Disambiguates
         *  concurrent downloads of the same season when the episode relation could not be
         *  resolved (loose episodes with no episodeNumber would otherwise collide). */
        ref: string;
        seasonNumber?: number;
        episodeNumber?: number;
        /** 0–1. */
        progress: number;
        dlspeed: number;
        eta: number;
        state: DownloadProgressState;
      }[];
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
  // Aimed at exactly one connection, never broadcast: a fallback to every
  // device of the user would let one phone pause them all.
  | {
      type: 'remote.command';
      cmdId: string;
      /** Absolute deadline. A frozen tab keeps its EventSource open, so a thaw
       *  can deliver a queued command minutes late; the controllee drops it. */
      expiresAt: number;
      /** The issuing controller's own target id: attribution only. */
      byTargetId: string | null;
      action: RemoteCommandAction;
      mediaId?: number;
      mediaFileId?: number;
      episodeId?: number;
      positionSeconds?: number;
      level?: number;
      muted?: boolean;
      trackId?: string;
      subtitleId?: string | null;
    }
  // Remote control: the target's live state, fanned out to every connection
  // of the owning user so any of them can act as a controller.
  | ({ type: 'remote.state'; targetId: string } & RemoteStatePayload)
  // Remote control: "refetch the target list". Carries no data on purpose.
  | { type: 'remote.targets_changed' }
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
  | { type: 'acquisition.grabbed'; mediaId: number; seasonNumber?: number; episodeNumber?: number }
  | { type: 'request.created'; requestId: number; mediaType: string; tmdbId: number; userId: number | null; kind: string; seasons: number[] | null }
  | { type: 'request.approved'; requestId: number; mediaId: number | null; mediaType: string; tmdbId: number; seasons: number[] | null; approvedByUserId: number | null }
  | { type: 'library.scan.completed'; libraryId: number; added: number; updated: number }
  | { type: 'settings.changed'; key: string };

/**
 * Every command is absolute / state-setting: never a delta. `seek` carries the
 * target position, `volume` the target level, `mute` the target flag. That is
 * what makes a retry and a double-tap idempotent without a dedupe cache.
 * `playpause` is the one intentional toggle, bound to a single button.
 */
export type RemoteCommandAction =
  | 'load'
  | 'play'
  | 'pause'
  | 'playpause'
  | 'stop'
  | 'seek'
  | 'volume'
  | 'mute'
  | 'next'
  | 'audio'
  | 'subtitle';

/** Playback state of one target, as last reported by the target itself. */
export interface RemoteStatePayload {
  sessionId: string;
  mediaId: number | null;
  mediaFileId: number;
  episodeId?: number | null;
  mediaTitle: string | null;
  episodeLabel: string | null;
  posterUrl: string | null;
  positionSeconds: number;
  durationSeconds: number;
  state: 'playing' | 'paused' | 'buffering';
  volume: number | null;
  muted: boolean | null;
  supportsVolume: boolean;
  quality: string | null;
  audioTrackIndex: number | null;
  subtitleTrackIndex: number | null;
  /** Echo of the last command the target applied: the semantic ack. */
  lastCmdId: string | null;
}

/**
 * What one live SSE connection knows about itself. The open socket IS the
 * presence signal, so there is deliberately no `lastSeen` and no sweeper: a
 * second liveness source would need its own GC and would be wrong the moment
 * a device is unplugged.
 */
export interface ConnectionIdentity {
  userId: number;
  /** `deviceId#tabNonce`: stable across this connection's reconnects (unlike
   *  the connection id, reminted every time) and unique per screen (unlike the
   *  device id alone, shared by two tabs). Null for a client that predates the
   *  announce: it simply never becomes a target. */
  targetId: string | null;
  formFactor: string | null;
  tvPlatform: string | null;
  userAgent: string | null;
  since: number;
}

export interface RemoteTargetConnection extends ConnectionIdentity {
  connectionId: string;
}

/** A client with no SSE primitive (the native TV app) polls instead, so its
 *  commands wait in a queue rather than being written to a socket. */
interface PolledTarget extends ConnectionIdentity {
  queue: SseEvent[];
  lastPoll: number;
}

/** A polled target is present only as long as it keeps polling: the same rule
 *  as an open socket, expressed on the cadence the client actually uses. */
const POLLED_TARGET_TTL_MS = 30_000;
/** Bounded so a device that registers and never polls cannot grow unchecked. */
const POLLED_QUEUE_MAX = 20;

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

/** Short enough to beat the ~60s idle cut of mobile carriers and proxies. */
const PING_INTERVAL_MS = 30_000;

@Injectable()
export class EventsService {
  private readonly log = new Logger(EventsService.name);
  private readonly subject = new Subject<SseEnvelope>();
  private readonly domainSubject = new Subject<DomainEvent>();
  private readonly connections = new Map<string, ConnectionIdentity>();
  private readonly polled = new Map<string, PolledTarget>();

  // Defaulted so every existing `new EventsService()` in other services'
  // tests keeps compiling — Nest's own DI always supplies the real instance.
  constructor(
    private readonly progressCache: DownloadProgressCacheService = new DownloadProgressCacheService(),
  ) {}

  /** Broadcast to every connected client. */
  emit(event: SseEvent): void {
    this.dispatch({ audience: null, connectionIds: null, event });
  }

  /** Deliver only to the given user's SSE connections. */
  emitToUser(userId: number, event: SseEvent): void {
    this.dispatch({ audience: [userId], connectionIds: null, event });
  }

  /** Deliver only to the given users' SSE connections. Empty list = nobody. */
  emitToUsers(userIds: number[], event: SseEvent): void {
    this.dispatch({ audience: userIds, connectionIds: null, event });
  }

  /** Escape hatch for a type outside the closed `SseEvent` union — namespaced
   *  plugin events (`plugin.<id>.<type>`). `audience: null` broadcasts. */
  emitRaw(type: string, payload: unknown, audience: number[] | null): void {
    const event = { type, payload } as unknown as SseEvent;
    this.dispatch({ audience, connectionIds: null, event });
  }

  /** Deliver only to one SSE connection (multi-device remote control).
   *  Returns false when the socket is already gone: a caller that reported
   *  success on a dropped command would be lying, so the miss is logged. */
  emitToConnection(connectionId: string, event: SseEvent): boolean {
    const polledTarget = this.polled.get(connectionId);
    if (polledTarget) {
      if (polledTarget.queue.length >= POLLED_QUEUE_MAX) {
        this.log.warn(
          `Dropped ${event.type}: queue full for polled target ${polledTarget.targetId}`,
        );
        return false;
      }
      polledTarget.queue.push(event);
      return true;
    }
    if (!this.connections.has(connectionId)) {
      this.log.warn(
        `Dropped ${event.type}: SSE connection ${connectionId} is gone`,
      );
      return false;
    }
    this.dispatch({
      audience: null,
      connectionIds: [connectionId],
      event,
    });
    return true;
  }

  /** Every user-scoped emit funnels through here, so `download.progress`'s
   *  replay cache (fed by whichever caller pushes it — core or an in-process
   *  bundle) never depends on catching every call site individually. */
  private dispatch(env: SseEnvelope): void {
    if (env.audience) {
      if (env.event.type === 'download.progress') {
        this.progressCache.record(env.audience, env.event);
      } else if (env.event.type === 'import.complete') {
        this.progressCache.clear(
          env.event.mediaId,
          env.event.seasonNumber,
          env.event.episodeNumber,
        );
      }
    }
    this.subject.next(env);
  }

  hasConnection(connectionId: string): boolean {
    return this.connections.has(connectionId);
  }

  /** Live targets owned by `userId`, newest connection first. */
  listForUser(userId: number): RemoteTargetConnection[] {
    const rows: RemoteTargetConnection[] = [];
    for (const [connectionId, identity] of this.connections) {
      if (identity.userId !== userId) continue;
      if (!identity.targetId) continue;
      rows.push({ connectionId, ...identity });
    }
    for (const [key, target] of this.polled) {
      if (Date.now() - target.lastPoll > POLLED_TARGET_TTL_MS) {
        this.polled.delete(key);
        this.log.log(`Polled target ${target.targetId} stopped polling`);
        this.emitToUser(target.userId, { type: 'remote.targets_changed' });
        continue;
      }
      if (target.userId !== userId || !target.targetId) continue;
      rows.push({ connectionId: key, ...target });
    }
    return rows.sort((a, b) => b.since - a.since);
  }

  /** One device cannot hold two live streams under one target id, so an older
   *  entry is a corpse the socket never reported: a killed webview or a dropped
   *  mobile network sends no FIN, and the ping write does not reliably fail. */
  private evictSupersededConnections(userId: number, targetId: string): void {
    for (const [connectionId, identity] of this.connections) {
      if (identity.userId !== userId || identity.targetId !== targetId) continue;
      this.connections.delete(connectionId);
      this.log.log(`Evicted superseded connection for target ${targetId}`);
    }
  }

  /** Announce a client that cannot hold an SSE stream. The key doubles as its
   *  connection id so command delivery needs no branch at the call site. */
  registerPolledTarget(
    userId: number,
    identity: Omit<ConnectionIdentity, 'userId' | 'since'>,
  ): void {
    if (!identity.targetId) {
      this.log.warn(`Refused a polled-target registration with no target id (user ${userId})`);
      return;
    }
    const key = `polled:${identity.targetId}`;
    const existing = this.polled.get(key);
    this.polled.set(key, {
      userId,
      targetId: identity.targetId,
      formFactor: identity.formFactor ?? null,
      tvPlatform: identity.tvPlatform ?? null,
      userAgent: identity.userAgent ?? null,
      since: existing?.since ?? Date.now(),
      queue: existing?.queue ?? [],
      lastPoll: Date.now(),
    });
    if (!existing) {
      this.emitToUser(userId, { type: 'remote.targets_changed' });
    }
  }

  /** Hand a polled target its pending commands, at most once each. `null`
   *  distinguishes an unknown target from one with nothing waiting. */
  drainCommands(userId: number, targetId: string): SseEvent[] | null {
    const target = this.polled.get(`polled:${targetId}`);
    if (!target || target.userId !== userId) return null;
    target.lastPoll = Date.now();
    const pending = target.queue;
    target.queue = [];
    return pending;
  }

  /** Resolve a caller-scoped target id to the connection that currently owns
   *  it. Scoping to `userId` IS the authorization: a target id names nothing
   *  outside its owner's connections. */
  resolveTarget(userId: number, targetId: string): string | null {
    const matches = this.listForUser(userId).filter(
      (row) => row.targetId === targetId,
    );
    if (matches.length > 1) {
      this.log.warn(
        `Target ${targetId} maps to ${matches.length} live connections for user ${userId}: using the newest`,
      );
    }
    return matches[0]?.connectionId ?? null;
  }

  targetIdFor(connectionId: string | null | undefined): string | null {
    if (!connectionId) return null;
    return this.connections.get(connectionId)?.targetId ?? null;
  }

  /** Drop every stream a user holds. Called when an account is disabled, its
   *  role changes or it logs out: an SSE request is authorized once at connect
   *  and then lives for hours, so without this a revoked client stays a listed,
   *  commandable target. */
  dropConnectionsForUser(userId: number): void {
    let dropped = 0;
    for (const [connectionId, identity] of this.connections) {
      if (identity.userId !== userId) continue;
      this.connections.delete(connectionId);
      dropped++;
    }
    if (dropped > 0) {
      this.log.log(`Dropped ${dropped} SSE connection(s) for user ${userId}`);
      this.emitToUser(userId, { type: 'remote.targets_changed' });
    }
  }

  getStream(
    userId: number,
    identity?: Omit<ConnectionIdentity, 'userId' | 'since'>,
  ): Observable<MessageEvent> {
    return new Observable((subscriber) => {
      const connectionId = randomUUID();
      if (identity?.targetId) {
        this.evictSupersededConnections(userId, identity.targetId);
      }
      this.connections.set(connectionId, {
        userId,
        targetId: identity?.targetId ?? null,
        formFactor: identity?.formFactor ?? null,
        tvPlatform: identity?.tvPlatform ?? null,
        userAgent: identity?.userAgent ?? null,
        since: Date.now(),
      });
      if (identity?.targetId) {
        this.emitToUser(userId, { type: 'remote.targets_changed' });
      }

      subscriber.next({
        data: JSON.stringify({
          type: 'sse.connected',
          connectionId,
        } satisfies SseEvent),
      } as MessageEvent);

      // Replay this user's last-known progress so a client connecting between
      // publisher ticks isn't blind until the next one (audience-scoped —
      // `snapshotFor` only returns leaves this user was already a recipient of).
      for (const event of this.progressCache.snapshotFor(userId)) {
        subscriber.next({ data: JSON.stringify(event) } as MessageEvent);
      }

      const sub = this.subject.subscribe((env) => {
        if (!this.shouldDeliver(env, userId, connectionId)) return;
        subscriber.next({ data: JSON.stringify(env.event) } as MessageEvent);
      });

      // Named and data-less: no client dispatches it (the spec drops an event with
      // an empty data buffer), but the write still surfaces a dead socket.
      const ping = setInterval(() => {
        subscriber.next({ type: 'ping', data: '' } as MessageEvent);
      }, PING_INTERVAL_MS);

      return () => {
        clearInterval(ping);
        sub.unsubscribe();
        const had = this.connections.get(connectionId)?.targetId;
        this.connections.delete(connectionId);
        if (had) {
          this.emitToUser(userId, { type: 'remote.targets_changed' });
        }
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
