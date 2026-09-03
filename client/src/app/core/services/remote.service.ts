import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { Subject, firstValueFrom } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { RemoteCommand, RemoteQualityRung, SseService } from './sse.service';
import { ToastService } from './toast.service';
import { CastSettingsService } from './cast-settings.service';

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
  supportsVolume: boolean;
  subtitleId: string | null;
  quality: string | null;
  /** The target's own ladder: the only id space it accepts for a quality change. */
  qualities: RemoteQualityRung[] | null;
  autoplayBlocked: boolean;
  /** The target has an item queued after this one. */
  hasNext: boolean;
  audioTrackIndex: number | null;
  subtitleTrackIndex: number | null;
}

export interface RemoteTarget {
  targetId: string;
  userAgent: string | null;
  deviceName: string | null;
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
  qualityId?: string;
};

/** Semantic-ack budget. A cold transcode start is the only slow case. */
const ACK_TIMEOUT_MS = 3_000;
const LOAD_ACK_TIMEOUT_MS = 20_000;
/** Answered by restarting the stream, so the first report is a cold transcode
 *  start away rather than a frame: `next` remounts the player on another file
 *  and `quality` reloads the current one. */
const SLOW_ACK_ACTIONS: ReadonlySet<RemoteAction> = new Set<RemoteAction>([
  'load',
  'next',
  'quality',
]);
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
  private readonly castSettings = inject(CastSettingsService);
  private readonly translate = inject(TranslateService);

  // ── Controllee ──

  /** Commands that passed validation, for the player to apply. */
  readonly validated = new Subject<RemoteCommand>();
  /** Last command this device actually applied: rides the heartbeat as the ack. */
  readonly lastAppliedCmdId = signal<string | null>(null);

  // ── Controller ──

  readonly targets = signal<RemoteTarget[]>([]);
  readonly selectedTargetId = signal<string | null>(null);
  /** Read back from storage but not yet seen in a listing. A device picked in an
   *  earlier run may be long gone, and a selection that routes playback has to be
   *  one we know is online, so it only becomes the selection once a listing
   *  confirms it. */
  private restoredTargetId: string | null = this.readSelectedTarget();
  readonly pendingAction = signal<RemoteAction | null>(null);
  /** The target is rebuilding its stream for the same title at the same place.
   *  Derived from the command in flight, so it opens and closes with the ack
   *  rather than needing its own bookkeeping. */
  readonly restarting = computed(() => this.pendingAction() === 'quality');
  readonly targetOffline = signal(false);

  readonly selectedTarget = computed(() => {
    const id = this.selectedTargetId();
    return id ? (this.targets().find((t) => t.targetId === id) ?? null) : null;
  });
  /** A selection, not its live listing: a target that drops off `targets()`
   *  is still the one we're remoting to, just offline, so the overlay stays
   *  mounted and shows that instead of unmounting mid-interaction. */
  readonly isRemoting = computed(() => this.selectedTargetId() !== null);

  private stateAt = 0;
  /** The session a stop retired, so only its own farewell heartbeat is ignored. */
  private stoppedSessionId: string | null = null;
  private observingSince = 0;
  private expectedMediaFileId: number | null = null;
  private readonly reportedState = signal<RemoteNowPlaying | null>(null);
  private readonly pinnedVolume = signal<number | null>(null);
  private volumePinAt = 0;
  /** Same optimistic hold for a seek: the target reads its position back only
   *  once the seek lands, so without this the cue that triggered the seek stayed
   *  on screen until a later heartbeat. */
  private readonly pinnedPosition = signal<number | null>(null);
  private positionPinAt = 0;
  private readonly wallClock = signal(0);
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCmdId: string | null = null;
  private coalesceTimers = new Map<RemoteAction, ReturnType<typeof setTimeout>>();
  private tickHandle: ReturnType<typeof setInterval> | null = null;

  /** The target's own report is authoritative; between reports the position is
   *  extrapolated from its ARRIVAL time, so there is no clock to synchronise. */
  readonly interpolatedPosition = computed(() => {
    const s = this.reportedState();
    const pinned = this.pinnedPosition();
    const from = pinned ?? s?.positionSeconds ?? 0;
    const since = pinned !== null ? this.positionPinAt : this.stateAt;
    if (!s) return from;
    if (s.state !== 'playing') return from;
    const elapsed = (this.wallClock() - since) / 1000;
    return Math.min(from + Math.max(0, elapsed), s.durationSeconds || Infinity);
  });
  readonly targetState = computed(() => {
    const s = this.reportedState();
    const pinned = this.pinnedVolume();
    if (!s || pinned === null) return s;
    return { ...s, volume: pinned };
  });

  /** Drop what the target was playing and name what we asked for, so neither
   *  the previous title nor the old session's farewell heartbeat can stand in
   *  for the one that is starting. */
  noteLoadSent(mediaFileId: number | null): void {
    this.expectedMediaFileId = mediaFileId;
    this.stoppedSessionId = null;
    this.pinnedPosition.set(null);
    this.reportedState.set(null);
    this.observingSince = Date.now();
  }

  /** The selected target left its player. Same treatment as a stop we sent: the
   *  reading goes, and the farewell heartbeat behind it is ignored. */
  noteTargetStopped(targetId: string): void {
    if (!targetId || targetId !== this.selectedTargetId()) return;
    const pending = this.pendingAction();
    if (pending === 'quality') {
      // Same title, same position: the stream is being rebuilt underneath. The
      // reading on screen stays true, so keep it and just show it loading
      // rather than emptying the card between the two sessions.
      console.debug('[remote] target stopped to rebuild its stream', targetId);
      return;
    }
    if (pending && SLOW_ACK_ACTIONS.has(pending)) {
      // A load or a next moves to another file, so what is on screen no longer
      // describes anything: name what is coming instead.
      console.debug('[remote] target stopped to start another file', targetId, pending);
      this.noteLoadSent(null);
      return;
    }
    console.debug('[remote] target reported it stopped playing', targetId);
    this.noteStopSent();
  }

  /** Name the stopped session so its farewell heartbeat is not mistaken for
   *  playback that is still running. The exact session rather than a time
   *  window: switching episode on the target retires one session and starts
   *  another within the same second, and a window swallowed the new one's
   *  first report. Read before the state is cleared. */
  noteStopSent(): void {
    this.stoppedSessionId = this.reportedState()?.sessionId ?? null;
    this.expectedMediaFileId = null;
    this.pinnedPosition.set(null);
    this.reportedState.set(null);
    this.pendingAction.set(null);
  }

  /** True while a selected target has yet to report anything and could still
   *  be playing. A restored selection has no state until the next heartbeat, and
   *  the server-side join to the live session can lag a target's reconnect, so
   *  neither source can rule out playback for one cadence. */
  readonly awaitingFirstReport = computed(() => {
    if (!this.selectedTargetId() || this.reportedState()) return false;
    return this.wallClock() - this.observingSince < 12_000;
  });

  /** Hold the level the user just set until the target confirms it, so the
   *  slider stops fighting the reports it triggers. */
  /** Hold a requested position until the target reports one that matches it. */
  private pinPosition(seconds: number): void {
    this.pinnedPosition.set(seconds);
    this.positionPinAt = Date.now();
  }

  /** Every seek path funnels through here, so one call covers the cue button,
   *  the skip offers and a seekbar drag. */
  private notePositionIntent(input: RemoteCommandInput): void {
    if (input.action === 'seek' && input.positionSeconds !== undefined) {
      this.pinPosition(input.positionSeconds);
    }
  }

  pinVolume(level: number): void {
    this.pinnedVolume.set(level);
    this.volumePinAt = Date.now();
  }

  constructor() {
    this.sse.commands.subscribe((cmd) => this.onCommand(cmd));

    effect(() => {
      const event = this.sse.lastEvent();
      if (!event) return;
      if (event.type === 'remote.targets_changed') {
        untracked(() => void this.refreshTargets());
        return;
      }
    });

    // The server says which target stopped, so there is nothing to infer from
    // silence and nothing a trailing heartbeat can put back.
    this.sse.stopped.subscribe((targetId) => this.noteTargetStopped(targetId));

    effect(() => {
      this.sse.remoteState();
      untracked(() => this.ingestState());
    });

    effect(() => {
      this.reportedState();
      this.selectedTargetId();
      untracked(() => this.syncTicker());
    });

    effect(() => {
      const id = this.selectedTargetId();
      untracked(() => {
        this.observingSince = id ? Date.now() : 0;
      });
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
      'seek', 'volume', 'mute', 'next', 'audio', 'subtitle', 'quality',
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
    if (cmd.positionSeconds !== undefined) queryParams['t'] = Math.floor(cmd.positionSeconds);
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
      const restored = this.restoredTargetId;
      if (restored !== null) {
        this.restoredTargetId = null;
        this.selectTarget(rows.some((r) => r.targetId === restored) ? restored : null);
      }
      // A household row is the only one carrying an owner name, so that is the
      // exact discriminator. The selected target survives the filter: hiding it
      // would read as the device going offline.
      const selected = this.selectedTargetId();
      this.targets.set(
        this.castSettings.settings().showHouseholdTargets
          ? rows
          : rows.filter((r) => !r.ownerUsername || r.targetId === selected),
      );
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
    } catch (err) {
      // A transient fetch failure is not proof the list emptied: keep showing
      // the last known targets rather than tearing the picker down.
      console.warn('[remote] failed to refresh targets, keeping the current list', err);
    }
  }

  selectTarget(targetId: string | null): void {
    this.selectedTargetId.set(targetId);
    this.reportedState.set(null);
    this.targetOffline.set(false);
    this.expectedMediaFileId = null;
    try {
      if (targetId) localStorage.setItem(SELECTED_TARGET_KEY, targetId);
      else localStorage.removeItem(SELECTED_TARGET_KEY);
    } catch { /* blocked storage: selection is per-session only */ }

  }

  /** Coalesce a dragged control so one gesture costs a handful of POSTs. */
  sendCoalesced(targetId: string, input: RemoteCommandInput): void {
    // Hold the position at the gesture, not when the coalesced POST finally
    // goes out, so a drag tracks the thumb instead of trailing it.
    this.notePositionIntent(input);
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
    this.notePositionIntent(input);
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
        // `next` moves the target to another file, so the reading on screen is
        // the previous episode's until the new session reports. A quality
        // change keeps its file and position, so its reading stays valid.
        if (input.action === 'load' || input.action === 'next') {
          this.noteLoadSent(input.action === 'load' ? input.mediaFileId ?? null : null);
        }
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
      // The interceptor already toasts an HTTP failure, with the server's own
      // reason rather than one generic line, so toasting here too showed the
      // same failure twice. It stays silent on statuses the interceptor skips.
      const status = err instanceof HttpErrorResponse ? err.status : 0;
      if (status === 0 || status === 401) {
        this.toast.error(this.translate.instant('remote.error_command_failed'));
      }
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
      // An unlanded load must not keep blocking every later frame, from this
      // target or the next one selected, behind the wrong expectation.
      if (action === 'load') this.expectedMediaFileId = null;
      console.warn('[remote] no ack for', cmdId, action);
      this.toast.error(this.translate.instant('remote.error_no_response'));
    }, SLOW_ACK_ACTIONS.has(action) ? LOAD_ACK_TIMEOUT_MS : ACK_TIMEOUT_MS);
  }

  /** Fold one state report from the selected target into the controller UI. */
  ingestState(): void {
    const s = this.sse.remoteState();
    if (!s || s.targetId !== this.selectedTargetId()) return;
    // The target flushes one last heartbeat on its way out of the player; taking
    // it would put the stopped playback straight back on screen.
    if (this.stoppedSessionId && s.sessionId === this.stoppedSessionId) {
      console.debug('[remote] ignoring the farewell heartbeat of', s.sessionId);
      return;
    }
    this.stoppedSessionId = null;
    // An exact test rather than a time window: the outgoing session flushes one
    // last heartbeat for the previous file as it navigates away.
    if (this.expectedMediaFileId !== null) {
      if (s.mediaFileId !== this.expectedMediaFileId) {
        console.warn('[remote] dropping a state frame for the previous file', s.mediaFileId);
        return;
      }
      this.expectedMediaFileId = null;
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
      supportsVolume: s.supportsVolume,
      subtitleId: s.subtitleId,
      quality: s.quality,
      qualities: s.qualities,
      autoplayBlocked: s.autoplayBlocked,
      hasNext: s.hasNext,
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
    const pinnedPos = this.pinnedPosition();
    if (pinnedPos !== null) {
      const converged = Math.abs(s.positionSeconds - pinnedPos) < 3;
      if (converged || Date.now() - this.positionPinAt > 3_000) {
        this.pinnedPosition.set(null);
      }
    }
    if (s.lastCmdId && s.lastCmdId === this.pendingCmdId) {
      this.pendingCmdId = null;
      this.pendingAction.set(null);
      if (this.ackTimer) clearTimeout(this.ackTimer);
    }
  }

  /** Interpolate only while something is actually playing: a paused, idle or
   *  offline target has nothing to advance, and a spare timer would just wake
   *  the app. The second clause only covers the `awaitingFirstReport` window,
   *  before the target's first report says whether it is even playing. */
  private syncTicker(): void {
    const playing =
      this.reportedState()?.state === 'playing' ||
      (this.selectedTargetId() !== null && !this.reportedState());
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
