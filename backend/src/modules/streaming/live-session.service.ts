import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';

export type PlaybackState = 'playing' | 'paused' | 'buffering';
export type SessionKind = 'transcode' | 'remux' | 'directplay';

/**
 * Single live-session entry. The {@link sessionId} is the server-issued
 * handle the client embeds in every heartbeat — distinct from the
 * transcoding service's internal session key (`mediaFileId-uX`) so two
 * devices on the same media-file can each carry their own
 * {@link LiveSession} without colliding on the cache layer.
 */
export interface LiveSession {
  sessionId: string;
  userId: number | null;
  username: string | null;
  mediaFileId: number;
  mediaTitle: string | null;
  mediaType: string | null;
  posterUrl: string | null;
  profileHash: string | null;
  quality: string | null;
  kind: SessionKind;
  deviceLabel: string | null;
  startedAt: number;
  lastBeat: number;
  position: number;
  state: PlaybackState;
  audioTrackIndex: number | null;
  subtitleTrackIndex: number | null;
}

/** Snapshot returned from {@link LiveSessionRegistry.list} — same shape
 *  as {@link LiveSession} but with `Date` fields the admin DTO consumes. */
export interface LiveSessionSnapshot extends Omit<
  LiveSession,
  'startedAt' | 'lastBeat'
> {
  startedAt: Date;
  lastBeat: Date;
}

/** A live session is considered dead this long after the last
 *  heartbeat. 30 s = three missed beats at the client's 10 s cadence,
 *  enough to absorb transient network hiccups without dragging the
 *  ffmpeg keep-alive window. */
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_GC_INTERVAL_MS = 5_000;

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * In-memory registry of "currently watching" sessions. One entry per
 * sessionId emitted by `playback-info`. Refreshed by the heartbeat
 * piggybacked on `PUT /api/playback/media/:id/state`; explicit stop
 * via `DELETE /api/stream/sessions/:sessionId`. GC drops entries that
 * haven't been beaten in {@link DEFAULT_TTL_MS}.
 *
 * Drives the admin "now watching" dashboard and the ffmpeg job grace
 * window — `listForJob` reports whether a given encoder still has any
 * live consumer.
 */
@Injectable()
export class LiveSessionRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LiveSessionRegistry.name);
  private readonly sessions = new Map<string, LiveSession>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  private readonly ttlMs = readEnvInt(
    'STREAM_LIVE_SESSION_TTL_MS',
    DEFAULT_TTL_MS,
  );
  private readonly gcIntervalMs = readEnvInt(
    'STREAM_LIVE_SESSION_GC_INTERVAL_MS',
    DEFAULT_GC_INTERVAL_MS,
  );

  onModuleInit(): void {
    this.gcTimer = setInterval(() => this.runGc(), this.gcIntervalMs);
  }

  onModuleDestroy(): void {
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.sessions.clear();
  }

  /**
   * Create a new live session and return its server-issued id. Called
   * from the `playback-info` handler once the play method has been
   * resolved.
   */
  create(input: {
    userId: number | null;
    username: string | null;
    mediaFileId: number;
    mediaTitle?: string | null;
    mediaType?: string | null;
    posterUrl?: string | null;
    profileHash?: string | null;
    quality?: string | null;
    kind: SessionKind;
    deviceLabel?: string | null;
    position?: number;
  }): LiveSession {
    const now = Date.now();
    const session: LiveSession = {
      sessionId: randomUUID(),
      userId: input.userId,
      username: input.username,
      mediaFileId: input.mediaFileId,
      mediaTitle: input.mediaTitle ?? null,
      mediaType: input.mediaType ?? null,
      posterUrl: input.posterUrl ?? null,
      profileHash: input.profileHash ?? null,
      quality: input.quality ?? null,
      kind: input.kind,
      deviceLabel: input.deviceLabel ?? null,
      startedAt: now,
      lastBeat: now,
      position: input.position ?? 0,
      state: 'playing',
      audioTrackIndex: null,
      subtitleTrackIndex: null,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  /**
   * Refresh an existing session from a heartbeat payload. Returns the
   * updated entry or `null` when the session is unknown / expired —
   * caller can surface that to the client so it re-issues a fresh
   * `playback-info` request.
   */
  heartbeat(
    sessionId: string,
    payload: {
      position?: number;
      state?: PlaybackState;
      quality?: string | null;
      audioTrackIndex?: number | null;
      subtitleTrackIndex?: number | null;
    },
  ): LiveSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.lastBeat = Date.now();
    if (payload.position !== undefined) session.position = payload.position;
    if (payload.state) session.state = payload.state;
    if (payload.quality !== undefined) session.quality = payload.quality;
    if (payload.audioTrackIndex !== undefined) {
      session.audioTrackIndex = payload.audioTrackIndex;
    }
    if (payload.subtitleTrackIndex !== undefined) {
      session.subtitleTrackIndex = payload.subtitleTrackIndex;
    }
    return session;
  }

  /** Drop a session explicitly. Returns whether the id was known. */
  stop(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** Lookup by id without mutating lastBeat. */
  get(sessionId: string): LiveSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /** Active sessions for the admin dashboard — `Date`-typed snapshots. */
  list(): LiveSessionSnapshot[] {
    return [...this.sessions.values()].map(toSnapshot);
  }

  /** Sessions matching a given (user, file, profile) triple — used to
   *  decide whether an ffmpeg job still has any consumer. */
  listForJob(
    userId: number | null,
    mediaFileId: number,
    profileHash: string,
  ): LiveSession[] {
    const matches: LiveSession[] = [];
    for (const s of this.sessions.values()) {
      if (
        s.userId === userId &&
        s.mediaFileId === mediaFileId &&
        s.profileHash === profileHash
      ) {
        matches.push(s);
      }
    }
    return matches;
  }

  /** Visible for tests / metrics. */
  size(): number {
    return this.sessions.size;
  }

  private runGc(): void {
    const cutoff = Date.now() - this.ttlMs;
    const expired: string[] = [];
    for (const [id, session] of this.sessions) {
      if (session.lastBeat < cutoff) expired.push(id);
    }
    for (const id of expired) {
      this.sessions.delete(id);
    }
    if (expired.length) {
      this.log.log(
        `gc: dropped ${expired.length} session(s) past ${Math.round(this.ttlMs / 1000)}s ttl`,
      );
    }
  }
}

function toSnapshot(s: LiveSession): LiveSessionSnapshot {
  return {
    ...s,
    startedAt: new Date(s.startedAt),
    lastBeat: new Date(s.lastBeat),
  };
}
