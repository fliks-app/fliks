import { DestroyRef, Injectable, Injector, inject } from '@angular/core';
import { AuthService } from '../auth.service';
import { AutoDownloadService } from '../auto-download.service';
import { NetworkService } from '../network.service';
import { OfflinePlaybackSyncService, refused } from '../offline-playback-sync.service';
import type { QoeSample } from '../playback-engine';
import { QoeReporter } from '../qoe-reporter.service';
import { RemoteService } from '../remote.service';
import { ServerConfigService } from '../server-config.service';
import { SessionSyncService } from '../session-sync.service';
import type { RemoteQualityRung } from '../sse.service';
import { StreamingApiService, lostCurrentSession } from '../api/streaming-api.service';
import type { PlaybackOutput } from './playback-output';
import { PlaybackSession } from './playback-session';

export const HEARTBEAT_MS = 10_000;
const FORCED_SAVE_COALESCE_MS = 300;
const MIN_BEAT_GAP_MS = 2_000;

export type HeartbeatBody = {
  positionSeconds: number;
  durationSeconds: number;
  mediaFileId: number;
  episodeId?: number;
  sessionId?: string;
  state?: 'playing' | 'paused' | 'buffering';
  quality?: string | null;
  volume?: number;
  muted?: boolean;
  lastCmdId?: string;
  lastCmdRefused?: string;
  audioTrackIndex?: number | null;
  episodeLabel?: string | null;
  supportsVolume?: boolean;
  subtitleId?: string | null;
  qualities?: RemoteQualityRung[] | null;
  autoplayBlocked?: boolean;
  hasNext?: boolean;
  castDevice?: string;
  qoe?: QoeSample;
};

/** What the native side repeats while the WebView is suspended; `token` resolves the stream token of the file. */
export interface BackgroundBeat {
  url: string;
  body: HeartbeatBody;
  token: () => Promise<string | null>;
}

/** What a beat reports on, and what only its owner knows how to do. */
export interface HeartbeatSource {
  /** The output whose state the beat carries. */
  output(): PlaybackOutput;
  item(): { mediaId: number; fileId: number; episodeId: number | undefined };
  /** False while the owner has nothing to report (errored, pre-roll, another account's receiver). */
  reportable(): boolean;
  /** Plays a download: no stream token to refresh. */
  offline?(): boolean;
  /** Corrects what the output reads, e.g. the playhead before a load's seek lands. */
  reading?(r: { position: number; duration: number }): { position: number; duration: number };
  extras(sessionId: string | undefined): Pick<HeartbeatBody, 'episodeLabel' | 'castDevice' | 'qoe'>;
  background?(beat: BackgroundBeat): Promise<void> | void;
  /** The backend lost the session this beat carried. */
  onLostSession(position: number): void | Promise<void>;
  /** The beat never landed. */
  onBeatFailed?(): void;
}

/** Who reports: the page while the session plays on this device, the receiver's own source while it plays on Cast. */
export type HeartbeatRank = 'page' | 'receiver';

/** The one beater of the playback state: every registered source shares its cadence, throttle and handling. */
@Injectable({ providedIn: 'root' })
export class PlaybackHeartbeat {
  private readonly streamingApi = inject(StreamingApiService);
  private readonly auth = inject(AuthService);
  private readonly network = inject(NetworkService);
  private readonly offlineSync = inject(OfflinePlaybackSyncService);
  // Resolved on use: it pulls in the download stack for one rare answer.
  private readonly injector = inject(Injector);
  private readonly sessionSync = inject(SessionSyncService);
  private readonly remote = inject(RemoteService);
  private readonly qoe = inject(QoeReporter);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly session = inject(PlaybackSession);
  private readonly _destroyed = inject(DestroyRef).onDestroy(() => this.stop());

  private readonly sources: { source: HeartbeatSource; rank: HeartbeatRank }[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private trailing: ReturnType<typeof setTimeout> | null = null;
  private lastForcedSaveAt = 0;
  /** Wall-clock ms of the last PUT to /state; time-based so a paused player still beats every 10 s, which the
   *  backend's live session needs to stay warm. */
  lastSaveAt = 0;

  /** The disposer clears only this registration. */
  register(source: HeartbeatSource, rank: HeartbeatRank): () => void {
    const entry = { source, rank };
    this.sources.push(entry);
    this.interval ??= setInterval(() => void this.beat(), HEARTBEAT_MS);
    return () => {
      const i = this.sources.indexOf(entry);
      if (i >= 0) this.sources.splice(i, 1);
      if (!this.sources.length) this.stop();
    };
  }

  private stop(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.trailing) clearTimeout(this.trailing);
    this.interval = this.trailing = null;
  }

  private winner(): HeartbeatSource | undefined {
    const rank: HeartbeatRank = this.session.kind() === 'cast' ? 'receiver' : 'page';
    return (this.sources.find((s) => s.rank === rank) ?? this.sources[0])?.source;
  }

  /** Native ticks are not throttled in the background, unlike the interval: they keep the beat going in PiP and
   *  with the screen off. */
  beatIfDue(): void {
    if (Date.now() - this.lastSaveAt >= HEARTBEAT_MS) void this.beat();
  }

  /** A forced beat that skips the coalescing: the outgoing item's last state before a switch closes the saves. */
  bank(): Promise<void> {
    this.lastForcedSaveAt = 0;
    return this.beat(true);
  }

  /** `force` bypasses only the 2 s throttle: after a remote command, its ack arrives in ~1 s, not 10 s. */
  async beat(force = false): Promise<void> {
    const source = this.winner();
    if (!source) return;
    if (force) {
      const now = Date.now();
      if (now - this.lastForcedSaveAt < FORCED_SAVE_COALESCE_MS) {
        // Coalesce, never drop: a start fires first frame, transport flip and track auto-selection within
        // milliseconds, and dropping the later ones reported the state from before playback began.
        if (this.trailing) clearTimeout(this.trailing);
        this.trailing = setTimeout(() => {
          this.trailing = null;
          void this.beat(true);
        }, FORCED_SAVE_COALESCE_MS);
        return;
      }
      this.lastForcedSaveAt = now;
    }
    const out = source.output();
    // Another device's output beats for itself.
    if (!out.reportsHere() || !source.reportable()) return;

    const { mediaId, fileId, episodeId } = source.item();
    const read = { position: out.position(), duration: out.duration() };
    const { position, duration } = source.reading?.(read) ?? read;
    // Beat even at position 0 (the backend refreshes the live session off this PUT); bail only on a non-finite reading.
    if (!Number.isFinite(position)) return;

    const now = Date.now();
    if (!force && now - this.lastSaveAt < MIN_BEAT_GAP_MS) return;
    this.lastSaveAt = now;
    const offline = !!source.offline?.();
    // Cache hit until 30 min remain; later URLs (sprites, subtitles, reloads) then carry a fresh token.
    if (!offline) void this.auth.ensureStreamToken(fileId);

    const sessionId = out.sessionId();
    const payload: HeartbeatBody = {
      positionSeconds: position,
      durationSeconds: duration || 0,
      mediaFileId: fileId,
      episodeId,
      ...source.extras(sessionId),
    };
    if (sessionId) {
      payload.sessionId = sessionId;
      payload.state = out.buffering() ? 'buffering' : out.uiPaused() ? 'paused' : 'playing';
      payload.volume = out.volume();
      payload.muted = out.muted();
      const lastCmdId = this.remote.lastAppliedCmdId();
      if (lastCmdId) payload.lastCmdId = lastCmdId;
      const lastCmdRefused = this.remote.lastCmdRefused();
      if (lastCmdId && lastCmdRefused) payload.lastCmdRefused = lastCmdRefused;
      payload.quality = out.activeQualityId() ?? null;
      // A controller cannot rebuild the rungs: they follow the output's own decision.
      payload.qualities = out.availableQualities().map((q) => ({ id: q.id, label: q.label, lowBandwidth: q.lowBandwidth }));
      payload.audioTrackIndex = out.audioStreamIndex();
      payload.supportsVolume = out.canSetVolume();
      payload.subtitleId = out.activeSubtitleId();
      payload.autoplayBlocked = out.autoplayBlocked();
      payload.hasNext = out.canPlayNext();
    }

    const getToken = async () => (await this.auth.ensureStreamToken(fileId)) ?? this.auth.accessToken;
    const background = source.background?.({
      url: this.serverConfig.resolveUrl(`/api/playback/media/${mediaId}/state`),
      body: { ...payload, qoe: undefined },
      token: getToken,
    });
    if (background instanceof Promise) await background;

    // The offline queue persists position only; heartbeat fields are pointless once the backend session expired.
    const offlinePayload = { mediaId, mediaFileId: fileId, episodeId, positionSeconds: position, durationSeconds: duration || 0 };
    if (!this.network.isOnline()) {
      this.offlineSync.queue(offlinePayload);
      source.onBeatFailed?.();
      return;
    }
    try {
      const response = await this.streamingApi.updatePlaybackState(mediaId, payload);
      if (sessionId) void this.qoe.flush(sessionId);
      // The backend lost our session (restart, long idle): the owner reloads with a fresh one before the buffer drains.
      if (lostCurrentSession(response, sessionId, source.output().sessionId())) void source.onLostSession(position);
      if (response?.superseded && sessionId) void this.sessionSync.handleSuperseded(sessionId);
      // Auto-delete-after-watched: the moment the server marks this item completed, drop its auto-managed download.
      if (response?.state?.completed) void this.injector.get(AutoDownloadService).onItemCompleted(fileId);
      // Keep the device's own resume point current on the happy path: /state is uncacheable, so an offline replay has only this.
      this.offlineSync.record(offlinePayload);
    } catch (e) {
      if (refused(e)) return;
      this.offlineSync.queue(offlinePayload);
      // The session's fate is unknown: re-run the resume path once online rather than wait for a 410 on the next segment.
      source.onBeatFailed?.();
    }
  }
}
