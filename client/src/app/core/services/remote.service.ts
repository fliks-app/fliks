import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { Subject, firstValueFrom } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { RemoteCommand, SseService } from './sse.service';
import { ToastService } from './toast.service';

export type RemoteAction = RemoteCommand['action'];

export interface RemoteNowPlaying {
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
  quality: string | null;
  audioTrackIndex: number | null;
  subtitleTrackIndex: number | null;
}

export interface RemoteTarget {
  targetId: string;
  userAgent: string | null;
  systemName: string | null;
  formFactor: string | null;
  tvPlatform: string | null;
  /** Set when the target belongs to a household member rather than the caller. */
  ownerUsername?: string | null;
  nowPlaying: RemoteNowPlaying | null;
}

/** Payload of a command, minus what the server stamps. */
export type RemoteCommandInput = {
  action: RemoteAction;
  mediaId?: number;
  mediaFileId?: number;
  episodeId?: number;
  positionSeconds?: number;
  level?: number;
  muted?: boolean;
  trackId?: string;
  subtitleId?: string | null;
};

/** Semantic-ack budget. A cold transcode start is the only slow case. */
const ACK_TIMEOUT_MS = 3_000;
const LOAD_ACK_TIMEOUT_MS = 20_000;
/** Matches the Cast sender's window so a drag emits a handful of POSTs, not one per input event. */
const DISPATCH_COALESCE_MS = 220;
const SELECTED_TARGET_KEY = 'fliks.remote.target';

/**
 * Both halves of the remote-control protocol.
 *
 * As a *controllee* every client validates the commands aimed at it and
 * republishes them for the player to apply: the expiry and unknown-action
 * guards live here and nowhere else, so a second consumer cannot skip them.
 *
 * As a *controller* it owns the target list, the selected target, and the
 * optimistic state the UI reads while waiting for the target's own report.
 */
@Injectable({ providedIn: 'root' })
export class RemoteService {
  private readonly http = inject(HttpClient);
  private readonly sse = inject(SseService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  // ── Controllee ──

  /** Commands that passed validation, for the player to apply. */
  readonly validated = new Subject<RemoteCommand>();
  /** Last command this device actually applied: rides the heartbeat as the ack. */
  readonly lastAppliedCmdId = signal<string | null>(null);

  // ── Controller ──

  readonly targets = signal<RemoteTarget[]>([]);
  readonly selectedTargetId = signal<string | null>(this.readSelectedTarget());
  readonly pendingAction = signal<RemoteAction | null>(null);
  readonly targetOffline = signal(false);
  /** True when the target loaded a file but its browser refused to autoplay. */
  readonly targetBlocked = signal(false);

  readonly selectedTarget = computed(() => {
    const id = this.selectedTargetId();
    return id ? (this.targets().find((t) => t.targetId === id) ?? null) : null;
  });
  readonly isRemoting = computed(() => this.selectedTarget() !== null);

  private stateAt = 0;
  private stopSentAt = 0;
  private readonly reportedState = signal<RemoteNowPlaying | null>(null);
  private readonly pinnedVolume = signal<number | null>(null);
  private volumePinAt = 0;
  private readonly wallClock = signal(0);
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCmdId: string | null = null;
  private coalesceTimers = new Map<RemoteAction, ReturnType<typeof setTimeout>>();
  private tickHandle: ReturnType<typeof setInterval> | null = null;

  /** The target's own report is authoritative; between reports the position is
   *  extrapolated from its ARRIVAL time, so there is no clock to synchronise. */
  readonly interpolatedPosition = computed(() => {
    const s = this.reportedState();
    if (!s) return 0;
    if (s.state !== 'playing') return s.positionSeconds;
    const elapsed = (this.wallClock() - this.stateAt) / 1000;
    return Math.min(s.positionSeconds + Math.max(0, elapsed), s.durationSeconds || Infinity);
  });
  readonly targetState = computed(() => {
    const s = this.reportedState();
    const pinned = this.pinnedVolume();
    if (!s || pinned === null) return s;
    return { ...s, volume: pinned };
  });

  /** Stamp a stop so the target's farewell heartbeat is not mistaken for
   *  playback that is still running. */
  noteStopSent(): void {
    this.stopSentAt = Date.now();
    this.reportedState.set(null);
    this.pendingAction.set(null);
  }

  /** Hold the level the user just set until the target confirms it, so the
   *  slider stops fighting the reports it triggers. */
  pinVolume(level: number): void {
    this.pinnedVolume.set(level);
    this.volumePinAt = Date.now();
  }

  constructor() {
    this.sse.commands.subscribe((cmd) => this.onCommand(cmd));

    effect(() => {
      const event = this.sse.lastEvent();
      if (event?.type !== 'remote.targets_changed') return;
      untracked(() => void this.refreshTargets());
    });

    effect(() => {
      this.sse.remoteState();
      untracked(() => this.ingestState());
    });

    effect(() => {
      this.reportedState();
      untracked(() => this.syncTicker());
    });

    // A reconnect remints the connection id, so a list built from live
    // connections is stale: refetch on our own reconnect too.
    effect(() => {
      if (!this.sse.connectionId()) return;
      untracked(() => void this.refreshTargets());
    });
  }

  // ── Controllee half ──

  private onCommand(cmd: RemoteCommand): void {
    if (Date.now() > cmd.expiresAt) {
      // A frozen tab or a suspended TV app keeps its EventSource open, so a
      // thaw can deliver a queued command minutes late.
      console.warn('[remote] dropped expired command', cmd.cmdId, cmd.action);
      return;
    }
    if (!this.isKnownAction(cmd.action)) {
      console.warn('[remote] dropped unknown action', cmd.cmdId, cmd.action);
      return;
    }
    if (cmd.action === 'load') {
      void this.applyLoad(cmd);
      return;
    }
    this.validated.next(cmd);
  }

  private isKnownAction(action: string): action is RemoteAction {
    return [
      'load', 'play', 'pause', 'playpause', 'stop',
      'seek', 'volume', 'mute', 'next', 'audio', 'subtitle',
    ].includes(action);
  }

  /** `load` is the one action the player cannot own: its command effect filters
   *  on the file it already has, and an idle device has no player at all. */
  private async applyLoad(cmd: RemoteCommand): Promise<void> {
    if (!cmd.mediaFileId) {
      console.warn('[remote] load without a mediaFileId', cmd.cmdId);
      return;
    }
    this.lastAppliedCmdId.set(cmd.cmdId);
    const queryParams: Record<string, string | number> = {};
    if (cmd.mediaId) queryParams['mediaId'] = cmd.mediaId;
    if (cmd.episodeId) queryParams['episodeId'] = cmd.episodeId;
    if (cmd.positionSeconds) queryParams['t'] = Math.floor(cmd.positionSeconds);
    // Force a remount so the same file reloads too, which is what lets this
    // work identically whether or not a player is already on screen.
    await this.router.navigateByUrl('/', { skipLocationChange: true });
    await this.router.navigate(['/watch', cmd.mediaFileId], { queryParams });
  }

  /** Called by the player once it has applied a command. */
  markApplied(cmdId: string): void {
    this.lastAppliedCmdId.set(cmdId);
  }

  // ── Controller half ──

  async refreshTargets(): Promise<void> {
    const self = this.sse.targetId();
    try {
      const rows = await firstValueFrom(
        this.http.get<RemoteTarget[]>('/api/remote/targets', {
          params: self ? { self } : {},
        }),
      );
      this.targets.set(rows);
      const selected = this.selectedTargetId();
      if (selected && !rows.some((r) => r.targetId === selected)) {
        // Never fall back to local playback on its own: offer it, don't do it.
        this.targetOffline.set(true);
        console.warn('[remote] selected target went offline', selected);
      } else if (selected) {
        this.targetOffline.set(false);
        // The target sends a farewell heartbeat as it leaves the player, which
        // lands after any local clear and would then sit there forever. Let the
        // server settle it: a live playback reports every 10s, so a silent
        // target the listing shows as empty really has stopped.
        const listed = rows.find((r) => r.targetId === selected);
        const silentFor = Date.now() - this.stateAt;
        if (listed && !listed.nowPlaying && this.reportedState() && silentFor > 15_000) {
          console.debug('[remote] target reports nothing playing, clearing its state');
          this.reportedState.set(null);
        }
      }
    } catch {
      this.targets.set([]);
    }
  }

  selectTarget(targetId: string | null): void {
    this.selectedTargetId.set(targetId);
    this.reportedState.set(null);
    this.targetOffline.set(false);
    this.targetBlocked.set(false);
    try {
      if (targetId) localStorage.setItem(SELECTED_TARGET_KEY, targetId);
      else localStorage.removeItem(SELECTED_TARGET_KEY);
    } catch { /* blocked storage: selection is per-session only */ }

  }

  /** Coalesce a dragged control so one gesture costs a handful of POSTs. */
  sendCoalesced(targetId: string, input: RemoteCommandInput): void {
    const existing = this.coalesceTimers.get(input.action);
    if (existing) clearTimeout(existing);
    this.coalesceTimers.set(
      input.action,
      setTimeout(() => {
        this.coalesceTimers.delete(input.action);
        void this.send(targetId, input);
      }, DISPATCH_COALESCE_MS),
    );
  }

  async send(targetId: string, input: RemoteCommandInput, retry = true): Promise<void> {
    this.pendingAction.set(input.action);
    try {
      const res = await firstValueFrom(
        this.http.post<{ cmdId: string }>(`/api/remote/${encodeURIComponent(targetId)}/command`, {
          ...input,
          byTargetId: this.sse.targetId(),
        }),
      );
      if (input.action === 'stop') {
        this.noteStopSent();
      } else {
        this.armAck(res.cmdId, input.action);
      }
    } catch (err) {
      if (retry && err instanceof HttpErrorResponse && err.status === 404) {
        // The target's SSE stream is reconnecting on its backoff, so its
        // connection id is new: re-resolve once before declaring it gone.
        await this.refreshTargets();
        if (this.targets().some((t) => t.targetId === targetId)) {
          return this.send(targetId, input, false);
        }
      }
      this.pendingAction.set(null);
      this.targetOffline.set(true);
      console.warn('[remote] command failed', input.action, targetId, err);
      this.toast.error(this.translate.instant('remote.error_command_failed'));
    }
  }

  /** The ack is the target echoing our cmdId in its own state report, so it
   *  confirms effect rather than mere receipt. */
  private armAck(cmdId: string, action: RemoteAction): void {
    this.pendingCmdId = cmdId;
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = setTimeout(() => {
      if (this.pendingCmdId !== cmdId) return;
      this.pendingCmdId = null;
      this.pendingAction.set(null);
      console.warn('[remote] no ack for', cmdId, action);
      this.toast.error(this.translate.instant('remote.error_no_response'));
    }, action === 'load' ? LOAD_ACK_TIMEOUT_MS : ACK_TIMEOUT_MS);
  }

  /** Fold one state report from the selected target into the controller UI. */
  ingestState(): void {
    const s = this.sse.remoteState();
    if (!s || s.targetId !== this.selectedTargetId()) return;
    // The target flushes one last heartbeat on its way out of the player; taking
    // it would put the stopped playback straight back on screen.
    if (Date.now() - this.stopSentAt < 3_000) {
      console.debug('[remote] ignoring a state frame that trails a stop');
      return;
    }
    this.stateAt = Date.now();
    this.wallClock.set(this.stateAt);
    this.reportedState.set({
      sessionId: s.sessionId,
      mediaId: s.mediaId,
      mediaFileId: s.mediaFileId,
      episodeId: s.episodeId,
      mediaTitle: s.mediaTitle,
      episodeLabel: s.episodeLabel,
      posterUrl: s.posterUrl,
      positionSeconds: s.positionSeconds,
      durationSeconds: s.durationSeconds,
      state: s.state,
      volume: s.volume,
      muted: s.muted,
      quality: s.quality,
      audioTrackIndex: s.audioTrackIndex,
      subtitleTrackIndex: s.subtitleTrackIndex,
    });
    this.targetOffline.set(false);
    const pinned = this.pinnedVolume();
    if (pinned !== null) {
      const converged = s.volume !== null && Math.abs(s.volume - pinned) < 0.02;
      if (converged || Date.now() - this.volumePinAt > 2_500) {
        this.pinnedVolume.set(null);
      }
    }
    if (s.lastCmdId && s.lastCmdId === this.pendingCmdId) {
      this.pendingCmdId = null;
      this.pendingAction.set(null);
      if (this.ackTimer) clearTimeout(this.ackTimer);
    }
  }

  /** Interpolate only while something is actually playing: a paused or absent
   *  target has nothing to advance, and a spare timer would just wake the app. */
  private syncTicker(): void {
    const playing = this.reportedState()?.state === 'playing';
    if (playing && this.tickHandle === null) {
      this.tickHandle = setInterval(() => this.wallClock.set(Date.now()), 500);
    } else if (!playing && this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  private readSelectedTarget(): string | null {
    try {
      return localStorage.getItem(SELECTED_TARGET_KEY);
    } catch {
      return null;
    }
  }
}
