import type { components } from '../../engine/schema';
import type {
  CreateLiveSessionInput,
  LiveSession,
  LiveSessionRegistry,
} from '../live-session.service';
import type { QoePipeline } from '../../qoe/core/types';
import type { CodecVariant } from '../transcoding/codec/types';
import { parseSourceFps } from '../transcoding/constants';

type Decision = components['schemas']['Decision'];
type ClientInfo = components['schemas']['ClientInfo'];
type SessionSnapshot = components['schemas']['SessionSnapshot'];
type EngineQoePipeline = components['schemas']['QoePipeline'];

/** What the host keeps in the engine's opaque session `tags`, so a restarted Node can rebuild presence. */
export interface PresenceTags {
  username?: string | null;
  mediaTitle?: string | null;
  mediaType?: string | null;
  posterUrl?: string | null;
  fanartUrl?: string | null;
  sseConnectionId?: string | null;
  attributedUserId?: number | null;
  deviceType?: string | null;
}

export function toTags(t: PresenceTags): Record<string, string> {
  return Object.fromEntries(
    Object.entries(t)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => [k, String(v)]),
  );
}

/** The engine's pipeline report with its absent members as the QoE core's explicit nulls. */
export function toQoePipeline(p: EngineQoePipeline): QoePipeline {
  const o = p.output;
  return {
    source: null,
    decode: null,
    encode: null,
    tonemap: null,
    burnIn: null,
    crop: null,
    audioTranscode: null,
    ...p,
    output: o
      ? {
          codec: o.codec ?? null,
          hdr: o.hdr ?? null,
          quality: o.quality ?? null,
          bitrate: o.bitrate ?? null,
          requested: o.requested ?? null,
        }
      : null,
  } as QoePipeline;
}

export interface PresenceFacts {
  sessionId: string;
  userId: number | null;
  mediaFileId: number;
  profileHash: string | null;
  quality: string | null;
  kind: LiveSession['kind'];
  decision: Decision;
  client: ClientInfo;
  tags: Record<string, string>;
  positionS: number;
  pinned: boolean;
}

/** The presence entry (remote control, dashboard, QoE) of an engine session, from the decision it runs. */
export function presenceInput(f: PresenceFacts): CreateLiveSessionInput {
  const { response: r } = f.decision;
  const attributed = Number(f.tags.attributedUserId);
  return {
    sessionId: f.sessionId,
    userId: f.userId,
    username: f.tags.username ?? null,
    mediaFileId: f.mediaFileId,
    mediaTitle: f.tags.mediaTitle ?? null,
    mediaType: f.tags.mediaType ?? null,
    posterUrl: f.tags.posterUrl ?? null,
    fanartUrl: f.tags.fanartUrl ?? null,
    profileHash: f.profileHash,
    quality: f.quality,
    attributedUserId: Number.isInteger(attributed) ? attributed : null,
    kind: f.kind,
    deviceLabel: f.client.userAgent ?? null,
    systemName: f.client.systemName ?? null,
    appVersion: f.client.appVersion ?? null,
    sseConnectionId: f.tags.sseConnectionId ?? null,
    position: f.positionS,
    audioPlan: r.audioPlan as never,
    audioTrackPlans: f.decision.audioPlans as never,
    videoVariant: f.decision.videoVariant as CodecVariant,
    deviceType: f.tags.deviceType === 'mobile' ? 'mobile' : 'desktop',
    hdrLadder: f.decision.useHdrLadder,
    tonemapping: f.decision.transcodeTonemapping,
    clientTonemap: r.clientTonemap,
    dolbyVision: r.dolbyVision,
    transcodeReasons: r.transcodeReasons,
    canCopyVideo: r.videoCopyStream,
    sourceFps: parseSourceFps(r.source.frameRate ?? undefined),
    pinned: f.pinned,
  };
}

/** Presence of a session the host did not open itself: after a Node restart, or another instance. */
export function presenceFromSnapshot(
  s: SessionSnapshot,
): CreateLiveSessionInput {
  const userId = Number(s.ownerId);
  return presenceInput({
    sessionId: s.sessionId,
    userId: Number.isInteger(userId) ? userId : null,
    mediaFileId: s.mediaFileId,
    profileHash: s.profileHash ?? null,
    quality: s.quality ?? null,
    kind: s.kind,
    decision: s.decision,
    client: s.client,
    tags: s.tags,
    positionS: s.positionS,
    pinned: s.pinned,
  });
}

/** Presence for a snapshot the registry does not know yet, with the engine's clocks. */
export function restorePresence(
  registry: LiveSessionRegistry,
  s: SessionSnapshot,
): LiveSession {
  const live = registry.create(presenceFromSnapshot(s));
  syncFromSnapshot(live, s);
  return live;
}

/** Stamps the engine's own clocks and player state on a presence rebuilt from a snapshot. */
export function syncFromSnapshot(live: LiveSession, s: SessionSnapshot): void {
  live.startedAt = s.openedAtMs;
  live.lastBeat = s.lastBeatMs;
  live.state =
    s.state === 'paused' || s.state === 'buffering' ? s.state : 'playing';
}

/** The engine's name for the job a session runs: `<file>-u<owner>-<hash>`, `anon` without an owner. */
export function jobKeyOf(s: SessionSnapshot): string {
  return `${s.mediaFileId}-${s.ownerId ? `u${s.ownerId}` : 'anon'}-${s.profileHash}`;
}
