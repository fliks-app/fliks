import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { components } from '../engine/schema';
import type { RemoteQualityRung } from '../scheduler/events.service';
import type { TranscodeReason } from './dto/playback-info.dto';

type AudioPlan = components['schemas']['AudioPlan'];
type BitrateHint = components['schemas']['BitrateHint'];

export type PlaybackState = 'playing' | 'paused' | 'buffering';
export type SessionKind = 'transcode' | 'remux' | 'directplay';

/** Presence of one engine session: who watches what, for the dashboard, remote control and QoE.
 *  {@link sessionId} is the engine's sid, embedded in every heartbeat. */
export interface LiveSession {
  sessionId: string;
  userId: number | null;
  username: string | null;
  mediaFileId: number;
  mediaTitle: string | null;
  mediaType: string | null;
  posterUrl: string | null;
  fanartUrl: string | null;
  /** The engine's profile hash of the job this playback runs. */
  profileHash: string | null;
  quality: string | null;
  /** The target's own quality ladder. Reported by the target rather than
   *  rebuilt here: the rungs depend on its transcode decision, so a list
   *  assembled elsewhere would offer ids it does not accept. */
  qualities: RemoteQualityRung[] | null;
  /** Set when this playback was launched from another device by remote control:
   *  the account it counts for, which is the launcher rather than the account
   *  the target is signed into. */
  attributedUserId: number | null;
  /** The target's browser refused to start playback without a user gesture. */
  autoplayBlocked: boolean;
  /** The target has an item queued after this one, so a controller may offer it. */
  hasNext: boolean;
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
  /** Client-composed "S1:E2 - Title" for a series, null for a film. Carried so
   *  a controller can label what a target plays without a second lookup. */
  episodeLabel: string | null;
  /** The target's engine owns a per-stream level. False where the platform owns
   *  it, so a controller hides its slider rather than offering a no-op. */
  supportsVolume: boolean;
  /** App-level id of the subtitle the target is showing, null for none. Both
   *  sides key it off the same buildSubtitleTracks entry, so it travels as is. */
  subtitleId: string | null;
  audioTrackIndex: number | null;
  subtitleTrackIndex: number | null;
  /** Reported by the client heartbeat: lets a remote-control controller show
   *  the target's real volume instead of a guess. */
  volume: number | null;
  muted: boolean | null;
  audioPlan: AudioPlan | null;
  /** Source fps at playback-info: the real length of a served segment. */
  sourceFps: number | null;
  /** The decision's bitrates per rung, keyed by rung name; null without a ladder. */
  bitrateByQuality: Record<string, BitrateHint> | null;
  hdrLadder: boolean;
  transcodeReasons: TranscodeReason[];
  /** HDR copied through to a client that tone-maps it locally. */
  clientTonemap: boolean;
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

/** Initial values of a presence; anything not supplied falls back to a safe default. */
export interface CreateLiveSessionInput {
  sessionId: string;
  userId: number | null;
  username: string | null;
  mediaFileId: number;
  mediaTitle?: string | null;
  mediaType?: string | null;
  posterUrl?: string | null;
  fanartUrl?: string | null;
  profileHash?: string | null;
  quality?: string | null;
  attributedUserId?: number | null;
  kind: SessionKind;
  deviceLabel?: string | null;
  systemName?: string | null;
  appVersion?: string | null;
  sseConnectionId?: string | null;
  position?: number;
  audioPlan?: AudioPlan | null;
  sourceFps?: number | null;
  bitrateByQuality?: Record<string, BitrateHint> | null;
  hdrLadder?: boolean;
  transcodeReasons?: TranscodeReason[];
  clientTonemap?: boolean;
}

/**
 * Every field of a live session, defaulted from its creation input. The single
 * definition of the shape: a test that needs one derives from this instead of
 * restating it, so adding a field never touches a spec.
 */
export function buildLiveSession(
  input: Omit<CreateLiveSessionInput, 'sessionId'>,
  sessionId: string,
  now: number,
): LiveSession {
  return {
    sessionId,
    userId: input.userId,
    username: input.username,
    mediaFileId: input.mediaFileId,
    mediaTitle: input.mediaTitle ?? null,
    mediaType: input.mediaType ?? null,
    posterUrl: input.posterUrl ?? null,
    fanartUrl: input.fanartUrl ?? null,
    profileHash: input.profileHash ?? null,
    quality: input.quality ?? null,
    qualities: null,
    attributedUserId: input.attributedUserId ?? null,
    autoplayBlocked: false,
    hasNext: false,
    kind: input.kind,
    deviceLabel: input.deviceLabel ?? null,
    systemName: input.systemName ?? null,
    appVersion: input.appVersion ?? null,
    sseConnectionId: input.sseConnectionId ?? null,
    startedAt: now,
    lastBeat: now,
    position: input.position ?? 0,
    state: 'playing',
    episodeLabel: null,
    supportsVolume: true,
    subtitleId: null,
    audioTrackIndex: null,
    subtitleTrackIndex: null,
    volume: null,
    muted: null,
    audioPlan: input.audioPlan ?? null,
    sourceFps: input.sourceFps ?? null,
    bitrateByQuality: input.bitrateByQuality ?? null,
    hdrLadder: input.hdrLadder ?? false,
    transcodeReasons: input.transcodeReasons ?? [],
    clientTonemap: input.clientTonemap ?? false,
  };
}

/**
 * In-memory presence of the engine's sessions. Created by playback-info, rebuilt from the engine's
 * events after a restart, refreshed by the heartbeat piggybacked on `PUT /api/playback/media/:id/state`
 * and dropped on `DELETE /api/stream/sessions/:sid` or the engine's `SessionEnded`: the engine owns
 * expiry, the per-owner cap and the revive window.
 */
@Injectable()
export class LiveSessionRegistry implements OnModuleDestroy {
  private readonly sessions = new Map<string, LiveSession>();

  onModuleDestroy(): void {
    this.sessions.clear();
  }

  create(input: CreateLiveSessionInput): LiveSession {
    const session = buildLiveSession(input, input.sessionId, Date.now());
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
      qualities?: RemoteQualityRung[] | null;
      autoplayBlocked?: boolean;
      hasNext?: boolean;
      episodeLabel?: string | null;
      supportsVolume?: boolean;
      subtitleId?: string | null;
      audioTrackIndex?: number | null;
      subtitleTrackIndex?: number | null;
      sseConnectionId?: string | null;
      volume?: number | null;
      muted?: boolean | null;
    },
  ): LiveSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.lastBeat = Date.now();
    if (payload.position !== undefined) session.position = payload.position;
    if (payload.state) session.state = payload.state;
    if (payload.quality !== undefined) session.quality = payload.quality;
    if (payload.qualities !== undefined) session.qualities = payload.qualities;
    if (payload.autoplayBlocked !== undefined) {
      session.autoplayBlocked = payload.autoplayBlocked;
    }
    if (payload.hasNext !== undefined) session.hasNext = payload.hasNext;
    if (payload.subtitleId !== undefined) {
      session.subtitleId = payload.subtitleId;
    }
    if (payload.supportsVolume !== undefined) {
      session.supportsVolume = payload.supportsVolume;
    }
    if (payload.episodeLabel !== undefined) {
      session.episodeLabel = payload.episodeLabel;
    }
    if (payload.audioTrackIndex !== undefined) {
      session.audioTrackIndex = payload.audioTrackIndex;
    }
    if (payload.subtitleTrackIndex !== undefined) {
      session.subtitleTrackIndex = payload.subtitleTrackIndex;
    }
    if (payload.sseConnectionId) {
      session.sseConnectionId = payload.sseConnectionId;
    }
    if (payload.volume !== undefined) session.volume = payload.volume;
    if (payload.muted !== undefined) session.muted = payload.muted;
    return session;
  }

  /** Drop a session explicitly. Returns whether the id was known. */
  stop(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  peek(sessionId: string): LiveSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /** Active sessions for the admin dashboard — `Date`-typed snapshots. */
  list(): LiveSessionSnapshot[] {
    return [...this.sessions.values()].map(toSnapshot);
  }

  size(): number {
    return this.sessions.size;
  }
}

function toSnapshot(s: LiveSession): LiveSessionSnapshot {
  return {
    ...s,
    startedAt: new Date(s.startedAt),
    lastBeat: new Date(s.lastBeat),
  };
}
