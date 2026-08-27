import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { StreamLifetime } from './lifetime-constants';
import type { TranscodeReason } from './dto/playback-info.dto';
import type { BurnInSubtitle } from './transcoding';
import type { CodecVariant } from './transcoding/codec/types';

export type PlaybackState = 'playing' | 'paused' | 'buffering';
export type SessionKind = 'transcode' | 'remux' | 'directplay';

export type AudioPlan =
  | { mode: 'copy'; codec: string }
  | {
      mode: 'transcode';
      codec: 'aac' | 'ac3' | 'eac3';
      bitrateBps: number;
    };

/**
 * Single live-session entry. The {@link sessionId} is the server-issued
 * handle the client embeds in every heartbeat — distinct from the
 * transcoding service's internal session key (`mediaFileId-uX`) so two
 * devices on the same media-file can each carry their own
 * {@link LiveSession} without colliding on the cache layer.
 *
 * All per-playback session state (mux flavour, audio plan, device
 * type, picked tracks, etc.) lives on this entry. The HLS routes
 * resolve their session via the `?sid=...` URL param the client
 * carries from `playback-info` onward, then read settings here —
 * this guarantees same-user multi-device, multi-user same-file, and
 * tab-vs-TV scenarios never clobber each other.
 */
export interface LiveSession {
  sessionId: string;
  userId: number | null;
  username: string | null;
  mediaFileId: number;
  mediaTitle: string | null;
  mediaType: string | null;
  posterUrl: string | null;
  /** Routing hash for this playback's transcode job (base hash + instanceId). */
  profileHash: string | null;
  /** Un-suffixed byte-layout hash; used to detect a concurrent sibling (#638). */
  profileBase: string | null;
  /** Instance suffix when split off a concurrent sibling, else null (#638). */
  instanceId: string | null;
  quality: string | null;
  kind: SessionKind;
  deviceLabel: string | null;
  /** Real host OS name+version ("macOS 26") from the client DeviceProfile;
   *  preferred over the UA-derived label in the admin streams dashboard. */
  systemName: string | null;
  /** Fliks client build version ("1.15.2") from the DeviceProfile; only
   *  non-web clients (native app / TV / desktop) send it. Shown next to the
   *  device label on the admin streams dashboard. */
  appVersion: string | null;
  /** SSE connection that owns this playback — admin remote-control is routed
   *  here so a second device on the same (user, file) is left untouched. */
  sseConnectionId: string | null;
  startedAt: number;
  lastBeat: number;
  position: number;
  state: PlaybackState;
  audioTrackIndex: number | null;
  subtitleTrackIndex: number | null;
  // ── Per-session settings owned by this entry ──
  useTs: boolean;
  audioPlan: AudioPlan | null;
  /** Per-rendition audio decision (one entry per source audio stream) for the
   *  multi-audio var_stream_map encode; null when uniform / not multi-audio. */
  audioTrackPlans: {
    copy: boolean;
    outputCodec: string;
    outputChannels?: number;
  }[] | null;
  audioStreamIndex: number | null;
  audioStreamCount: number;
  useExtXMedia: boolean;
  deviceType: 'mobile' | 'desktop';
  hdrLadder: boolean;
  /** Client renders HLS `SUBTITLES` renditions natively (AVPlayer,
   *  ExoPlayer, AVPlay, webOS) — the master advertises a subtitle group so
   *  cues show in PiP / AirPlay / lock-screen. Web (Shaka) leaves this false
   *  and keeps fetching sidecar VTT. Sourced from the device profile. */
  supportsHlsSubtitles: boolean;
  /** Engine fetches seg-0 on a load-then-seek (Shaka / Cast), so the seg-0
   *  early-start companion is worth spawning. Native engines seek straight to
   *  the resume segment and never request seg-0 — false skips the companion.
   *  Sourced from the device profile. */
  probesSegZero: boolean;
  /** Client can switch HLS variants at runtime (real ABR). `false` (e.g.
   *  embedded mpv) collapses the master to a single variant instead of the
   *  full ladder. Sourced from the device profile. */
  supportsAbr: boolean;
  videoVariant: CodecVariant | null;
  tonemapping: boolean;
  transcodeReasons: TranscodeReason[];
  burnIn: BurnInSubtitle | null;
  encoderPreset: string;
  canCopyVideo: boolean;
  canCopyAudio: boolean;
  /** Download sessions: kept past the short playback TTL so a paused
   *  download can resume without its segments 410ing. Active segment fetches
   *  keep it warm; GC reclaims it after a long idle window. */
  pinned: boolean;
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

/** Optional initial values when creating a session. Anything not
 *  supplied falls back to a safe default. */
export interface CreateLiveSessionInput {
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
  systemName?: string | null;
  appVersion?: string | null;
  sseConnectionId?: string | null;
  position?: number;
  useTs?: boolean;
  audioPlan?: AudioPlan | null;
  audioTrackPlans?: {
    copy: boolean;
    outputCodec: string;
    outputChannels?: number;
  }[] | null;
  audioStreamIndex?: number | null;
  audioStreamCount?: number;
  useExtXMedia?: boolean;
  deviceType?: 'mobile' | 'desktop';
  hdrLadder?: boolean;
  supportsHlsSubtitles?: boolean;
  probesSegZero?: boolean;
  supportsAbr?: boolean;
  videoVariant?: CodecVariant | null;
  tonemapping?: boolean;
  transcodeReasons?: TranscodeReason[];
  burnIn?: BurnInSubtitle | null;
  encoderPreset?: string;
  canCopyVideo?: boolean;
  canCopyAudio?: boolean;
  pinned?: boolean;
}

/** Partial update applied via {@link LiveSessionRegistry.update}. Only
 *  the fields supplied are touched. */
export type LiveSessionPatch = Partial<
  Pick<
    LiveSession,
    | 'useTs'
    | 'audioPlan'
    | 'audioStreamIndex'
    | 'audioStreamCount'
    | 'useExtXMedia'
    | 'deviceType'
    | 'hdrLadder'
    | 'videoVariant'
    | 'tonemapping'
    | 'transcodeReasons'
    | 'burnIn'
    | 'encoderPreset'
    | 'canCopyVideo'
    | 'canCopyAudio'
    | 'profileHash'
    | 'quality'
  >
>;

/**
 * In-memory registry of "currently watching" sessions. One entry per
 * sessionId emitted by `playback-info`. Refreshed by the heartbeat
 * piggybacked on `PUT /api/playback/media/:id/state`; explicit stop
 * via `DELETE /api/stream/sessions/:sessionId`. GC drops entries that
 * haven't been beaten inside `STREAM_LIVE_SESSION_TTL_MS` (30 s
 * default — three missed beats at the client's 10 s cadence, enough
 * to absorb transient network hiccups without dragging the ffmpeg
 * keep-alive window).
 *
 * A GC'd entry isn't forgotten: it is kept as a tombstone for
 * `STREAM_SESSION_REVIVE_TTL_MS` (15 min default, measured from its last
 * beat), and any request presenting that sid again revives it. The stream
 * URL therefore stays replayable across a laptop sleep or a network drop —
 * the client resumes on its existing sid instead of re-minting one and
 * reloading the engine (which tears the picture down to black).
 *
 * Drives the admin "now watching" dashboard and the ffmpeg job grace
 * window — `listForJob` reports whether a given encoder still has any
 * live consumer.
 */
@Injectable()
export class LiveSessionRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LiveSessionRegistry.name);
  private readonly sessions = new Map<string, LiveSession>();
  /** GC'd sessions still inside the revive window, keyed by sid. Consulted
   *  only by {@link resolve} — they are invisible to the dashboard, the
   *  per-user cap and the ffmpeg keep-alive, so a tombstone never holds an
   *  encoder alive. */
  private readonly tombstones = new Map<string, LiveSession>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  private readonly ttlMs = StreamLifetime.liveSessionTtlMs();
  private readonly gcIntervalMs = StreamLifetime.liveSessionGcIntervalMs();
  private readonly maxSessionsPerUser = StreamLifetime.maxSessionsPerUser();
  /** Idle window for pinned (download) sessions. Active segment fetches keep
   *  them warm; this only bounds how long a paused or finished download holds
   *  its session before GC reclaims it. */
  private readonly pinnedTtlMs = 60 * 60 * 1000;
  private readonly reviveTtlMs = StreamLifetime.sessionReviveTtlMs();
  /** Hard ceiling on tombstones so a client looping playback-info can't grow
   *  the map without bound; the oldest are dropped first. */
  private static readonly MAX_TOMBSTONES = 500;

  onModuleInit(): void {
    this.gcTimer = setInterval(() => this.runGc(), this.gcIntervalMs);
  }

  onModuleDestroy(): void {
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.sessions.clear();
    this.tombstones.clear();
  }

  /**
   * Create a new live session and return it. Called from the
   * `playback-info` handler once the play method has been resolved.
   */
  create(input: CreateLiveSessionInput): LiveSession {
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
      profileBase: input.profileHash ?? null,
      instanceId: null,
      quality: input.quality ?? null,
      kind: input.kind,
      deviceLabel: input.deviceLabel ?? null,
      systemName: input.systemName ?? null,
      appVersion: input.appVersion ?? null,
      sseConnectionId: input.sseConnectionId ?? null,
      startedAt: now,
      lastBeat: now,
      position: input.position ?? 0,
      state: 'playing',
      audioTrackIndex: null,
      subtitleTrackIndex: null,
      useTs: input.useTs ?? false,
      audioPlan: input.audioPlan ?? null,
      audioTrackPlans: input.audioTrackPlans ?? null,
      audioStreamIndex: input.audioStreamIndex ?? null,
      audioStreamCount: input.audioStreamCount ?? 0,
      useExtXMedia: input.useExtXMedia ?? false,
      deviceType: input.deviceType ?? 'desktop',
      hdrLadder: input.hdrLadder ?? false,
      supportsHlsSubtitles: input.supportsHlsSubtitles ?? false,
      // Default true: only a client that explicitly declares it seeks straight
      // to the resume segment opts out of the seg-0 companion. Pre-flag clients
      // keep the companion (a wasted seg-0 probe is harmless; a missing one
      // makes a seg-0-probing engine restart from scratch).
      probesSegZero: input.probesSegZero ?? true,
      // Default true: an older client that doesn't send the field keeps
      // today's full-ladder behaviour, same as a fresh capability flag.
      supportsAbr: input.supportsAbr ?? true,
      videoVariant: input.videoVariant ?? null,
      tonemapping: input.tonemapping ?? false,
      transcodeReasons: input.transcodeReasons ?? [],
      burnIn: input.burnIn ?? null,
      encoderPreset: input.encoderPreset ?? 'faster',
      canCopyVideo: input.canCopyVideo ?? false,
      canCopyAudio: input.canCopyAudio ?? false,
      pinned: input.pinned ?? false,
    };
    // #638: split a concurrent playback of the same content onto its own job so
    // two live viewers never share (and mutually kill) one ffmpeg. Race-free:
    // no await between this scan and sessions.set. A same-tab reload shares the
    // SSE connection, so it isn't counted as a sibling.
    if (input.profileHash != null) {
      const sibling = [...this.sessions.values()].some(
        (s) =>
          s.userId === input.userId &&
          s.mediaFileId === input.mediaFileId &&
          s.profileBase === input.profileHash &&
          now - s.lastBeat < (s.pinned ? this.pinnedTtlMs : this.ttlMs) &&
          !(
            s.sseConnectionId != null &&
            s.sseConnectionId === session.sseConnectionId
          ),
      );
      if (sibling) {
        session.instanceId =
          '~i' + session.sessionId.replace(/[^a-z0-9]/gi, '').slice(0, 8);
        session.profileHash = input.profileHash + session.instanceId;
      }
    }

    // Per-user concurrent-session cap. Legit multi-device viewing must never
    // be blocked, so we evict the user's oldest-beaten session rather than
    // reject the new one — this only bounds runaway session leaks from a
    // client that keeps issuing fresh playback-info without ever stopping.
    if (input.userId != null) {
      const own = [...this.sessions.values()].filter(
        (s) => s.userId === input.userId,
      );
      if (own.length >= this.maxSessionsPerUser) {
        const oldest = own.reduce((a, b) => (a.lastBeat <= b.lastBeat ? a : b));
        this.sessions.delete(oldest.sessionId);
        this.log.log(
          `evicted oldest session ${oldest.sessionId} for user ${input.userId} (cap ${this.maxSessionsPerUser})`,
        );
      }
    }
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
      sseConnectionId?: string | null;
    },
  ): LiveSession | null {
    const session = this.resolve(sessionId);
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
    if (payload.sseConnectionId) {
      session.sseConnectionId = payload.sseConnectionId;
    }
    return session;
  }

  /**
   * Refresh `lastBeat` off real stream traffic — a segment or playlist
   * fetch is itself proof the consumer is alive. Returns false when the
   * session is unknown so the HLS routes can 410 a stale `?sid=`.
   *
   * Without this the registry depends solely on the client's heartbeat
   * timer; a Cast receiver, whose only keep-alive is a flaky sender-side
   * beat, gets GC'd mid-playback and 410s on its next segment.
   */
  touch(sessionId: string): boolean {
    const session = this.resolve(sessionId);
    if (!session) return false;
    session.lastBeat = Date.now();
    return true;
  }

  /**
   * Apply a partial patch to a session. No-op when the session is
   * unknown (caller is expected to have just created it or to silently
   * fall through to defaults).
   */
  update(sessionId: string, patch: LiveSessionPatch): LiveSession | null {
    const session = this.resolve(sessionId);
    if (!session) return null;
    Object.assign(session, patch);
    return session;
  }

  /** Drop a session explicitly — an intentional stop is not revivable, so the
   *  tombstone goes too. Returns whether the id was known. */
  stop(sessionId: string): boolean {
    this.tombstones.delete(sessionId);
    return this.sessions.delete(sessionId);
  }

  /** Lookup by id without mutating lastBeat. Revives a tombstoned sid. */
  get(sessionId: string): LiveSession | null {
    return this.resolve(sessionId);
  }

  /**
   * Resolve a sid the caller presented: a live session, else a tombstone
   * inside the revive window — which is moved back into the live map. Anyone
   * still holding the sid (a heartbeat, a segment fetch) is proof the viewer
   * is back, and reviving keeps their stream URL valid: no 410, no fresh sid,
   * no engine reload. The encoder is gone by then; the next segment request
   * respawns it at the requested segment through the usual slow path.
   */
  private resolve(sessionId: string): LiveSession | null {
    const live = this.sessions.get(sessionId);
    if (live) return live;
    const buried = this.tombstones.get(sessionId);
    if (!buried) return null;
    this.tombstones.delete(sessionId);
    if (buried.lastBeat < Date.now() - this.reviveTtlMs) return null;
    this.sessions.set(sessionId, buried);
    this.log.log(
      `revived session ${sessionId} after ${Math.round(
        (Date.now() - buried.lastBeat) / 1000,
      )}s idle (file ${buried.mediaFileId}, user ${buried.userId})`,
    );
    return buried;
  }

  /**
   * Most-recently-active session for a (user, file). Fallback used by
   * HLS routes when the URL omits `?sid=` (direct-URL fetches, prewarm,
   * etc.) — picks the freshest entry so the active session wins over a
   * stale one. Returns null when nothing matches.
   */
  findCurrent(
    userId: number | null,
    mediaFileId: number,
  ): LiveSession | null {
    let best: LiveSession | null = null;
    for (const s of this.sessions.values()) {
      if (s.userId !== userId || s.mediaFileId !== mediaFileId) continue;
      if (!best || s.lastBeat > best.lastBeat) best = s;
    }
    return best;
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
    const now = Date.now();
    const expired: string[] = [];
    for (const [id, session] of this.sessions) {
      const ttl = session.pinned ? this.pinnedTtlMs : this.ttlMs;
      if (session.lastBeat < now - ttl) expired.push(id);
    }
    for (const id of expired) {
      const session = this.sessions.get(id)!;
      this.sessions.delete(id);
      // Insertion order is beat order, which is what the size trim below
      // walks — oldest first.
      this.tombstones.set(id, session);
    }
    for (const [id, session] of this.tombstones) {
      if (session.lastBeat < now - this.reviveTtlMs) this.tombstones.delete(id);
    }
    for (const id of this.tombstones.keys()) {
      if (this.tombstones.size <= LiveSessionRegistry.MAX_TOMBSTONES) break;
      this.tombstones.delete(id);
    }
    if (expired.length) {
      this.log.log(
        `gc: dropped ${expired.length} session(s) past ${Math.round(this.ttlMs / 1000)}s ttl` +
          `, revivable for ${Math.round(this.reviveTtlMs / 60000)}min`,
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
