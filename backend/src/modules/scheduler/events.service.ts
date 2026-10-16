import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Subject, Subscription } from 'rxjs';
import { DownloadProgressState } from '../../common/constants/download-progress-state';
import { bridgeConfigured, bridgeFetch } from '../bridge/server-bridge';
import type { MediaProgressSubject } from '../../common/utils/media-progress-subject.util';

export type SseEvent =
  | {
      type: 'task.progress';
      command: string;
      current: number;
      total: number;
      message: string;
      /** Present when the task's subject is a media: lets the client show the
       *  series/movie title and episode identity as separate fields instead of
       *  parsing `message`. Absent for a subject with no media behind it (an
       *  orphan-scan path, for instance): `message` alone carries it then. */
      subject?: MediaProgressSubject;
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
      /** 'translation' when the file was produced rather than fetched, so the
       *  client does not announce a download. Same vocabulary as the failure. */
      reason?: string;
      /** Unattended scheduler run — client skips the confirmation toast */
      automatic?: boolean;
    }
  | {
      type: 'subtitle.failed';
      mediaId: number;
      title: string;
      language: string;
      error: string;
      /** What failed, so the client picks the right message: 'translation',
       *  'rate_limit' for an engine quota, unset for an OCR run. */
      reason?: string;
      /** Set when `reason` is 'rate_limit': 'daily' quota needs a different
       *  message than a 'per-minute' one, since retrying now won't help. */
      scope?: string;
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
  // Payload-free: the System page's Activity table refetches
  // `GET /api/system/activity` on receipt rather than trusting a pushed list.
  | { type: 'activity.changed' }
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
      mediaType?: 'movie' | 'series';
      mediaFileId?: number;
      episodeId?: number;
      positionSeconds?: number;
      level?: number;
      muted?: boolean;
      trackId?: string;
      subtitleId?: string | null;
    }
  // Remote control: the target's live state, fanned out to every connection of
  // the owning user plus any household member authorized to control it.
  | ({ type: 'remote.state'; targetId: string } & RemoteStatePayload)
  // Remote control: "refetch the target list". Carries no data on purpose.
  | { type: 'remote.targets_changed' }
  // Remote control - that target stopped playing. Definitive, so a controller
  // never has to tell a closed player apart from a lagging report.
  | { type: 'remote.stopped'; targetId: string }
  // Social — delivered to the target user (emitted by the fliks-server social routes).
  | {
      type: 'social.followed' | 'social.follow_request' | 'social.follow_accepted';
      userId: number;
      username: string;
      avatar: string | null;
    }
  // A member recommended content to this user (fliks-server social recommend).
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
  | 'subtitle'
  | 'quality'
  /** Open a detail page: mirrors what the controller browses, plays nothing. */
  | 'browse';

/** One rung of a target's quality ladder. `lowBandwidth` marks an eco rung, of
 *  which there is one per height, so a controller listing both without it shows
 *  the same label twice. */
export interface RemoteQualityRung {
  id: string;
  label: string;
  lowBandwidth?: boolean;
}

/** Playback state of one target, as last reported by the target itself. */
export interface RemoteStatePayload {
  sessionId: string;
  mediaId: number | null;
  mediaFileId: number;
  episodeId?: number | null;
  mediaTitle: string | null;
  episodeLabel: string | null;
  posterUrl: string | null;
  fanartUrl: string | null;
  positionSeconds: number;
  durationSeconds: number;
  state: 'playing' | 'paused' | 'buffering';
  volume: number | null;
  muted: boolean | null;
  supportsVolume: boolean;
  subtitleId: string | null;
  quality: string | null;
  qualities: RemoteQualityRung[] | null;
  /** The target could not start on its own: a controller must say so rather than
   *  show a paused device whose play button is refused for the same reason. */
  autoplayBlocked: boolean;
  /** The target has something queued after the current item. */
  hasNext: boolean;
  audioTrackIndex: number | null;
  subtitleTrackIndex: number | null;
  /** Echo of the last command the target applied: the semantic ack. */
  lastCmdId: string | null;
}

/** Where an event goes: `/internal/events` of fliks-server (server/docs/bridge.md). */
type Forward =
  | { kind: 'sse'; event: SseEvent; userId?: number; userIds?: number[] }
  | {
      kind: 'raw';
      event: { type: string; payload: unknown };
      userIds?: number[];
    }
  | { kind: 'domain'; event: DomainEvent };

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15_000;

/**
 * Thin client of the Rust hub. Every emit is forwarded (never dispatched locally) and comes back
 * through `GET /internal/events/stream`, so each in-process subscriber runs once per event,
 * asynchronously. At-most-once: an event emitted while the stream is down is lost.
 */
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(EventsService.name);
  private readonly subject = new Subject<SseEvent>();
  private readonly domainSubject = new Subject<DomainEvent>();
  /** Forwards run one after the other so the hub sees them in emit order. */
  private sent: Promise<void> = Promise.resolve();
  private readonly stop = new AbortController();

  onModuleInit(): void {
    if (bridgeConfigured()) void this.consume();
  }

  onModuleDestroy(): void {
    this.stop.abort();
  }

  /** Broadcast to every connected client. */
  emit(event: SseEvent): void {
    this.forward({ kind: 'sse', event });
  }

  /** Deliver only to the given user's SSE connections. */
  emitToUser(userId: number, event: SseEvent): void {
    this.forward({ kind: 'sse', event, userId });
  }

  /** Deliver only to the given users' SSE connections. Empty list = nobody. */
  emitToUsers(userIds: number[], event: SseEvent): void {
    this.forward({ kind: 'sse', event, userIds });
  }

  /** Namespaced plugin events (`plugin.<id>.<type>`); `audience: null` broadcasts. */
  emitRaw(type: string, payload: unknown, audience: number[] | null): void {
    this.forward({
      kind: 'raw',
      event: { type, payload },
      userIds: audience ?? undefined,
    });
  }

  /** Publish a domain event to the in-process subscribers of every process. */
  emitDomain(event: DomainEvent): void {
    this.forward({ kind: 'domain', event });
  }

  /** Backend-internal listener: sees every SSE event whatever its audience. */
  subscribe(handler: (event: SseEvent) => void): Subscription {
    return this.subject.subscribe(handler);
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

  private forward(body: Forward): void {
    if (!bridgeConfigured()) return;
    this.sent = this.sent
      .then(() => bridgeFetch('/internal/events', { method: 'POST', body }))
      .then(
        () => undefined,
        (err: Error) =>
          this.log.error(
            `Event ${body.event.type} not delivered: ${err.message}`,
          ),
      );
  }

  private async consume(): Promise<void> {
    let delay = RECONNECT_MIN_MS;
    while (!this.stop.signal.aborted) {
      try {
        const res = await bridgeFetch('/internal/events/stream', {
          signal: this.stop.signal,
          raw: true,
        });
        delay = RECONNECT_MIN_MS;
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          for (
            let end = buffer.indexOf('\n\n');
            end >= 0;
            end = buffer.indexOf('\n\n')
          ) {
            this.dispatch(buffer.slice(0, end));
            buffer = buffer.slice(end + 2);
          }
        }
      } catch (err) {
        if (this.stop.signal.aborted) return;
        this.log.warn(`Event stream down: ${(err as Error).message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    }
  }

  private dispatch(block: string): void {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    let msg: Forward;
    try {
      msg = JSON.parse(data) as Forward;
    } catch {
      this.log.warn('Unreadable event on the internal stream');
      return;
    }
    if (msg.kind === 'domain') this.domainSubject.next(msg.event);
    else this.subject.next(msg.event as SseEvent);
  }
}
