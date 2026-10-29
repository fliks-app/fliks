import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import { NavigationEnd, Router } from '@angular/router';
import { Subject, filter, firstValueFrom } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { RemoteCommand, RemoteState, SseService } from './sse.service';
import { SKIP_ERROR_TOAST } from '../interceptors/error.interceptor';
import { ToastService } from './toast.service';
import { CastSettingsService } from './cast-settings.service';
import { CastService } from './cast.service';
import type { LaunchTracks } from './track-manager.service';
import { parseAudioIndex } from '../utils/player.utils';
import type { PlaybackSnapshot } from './playback/playback-output';

export type RemoteAction = RemoteCommand['action'];

/** What a target reports it is playing: the heartbeat minus its routing fields. */
export type RemoteNowPlaying = Omit<RemoteState, 'type' | 'targetId' | 'lastCmdId'>;

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
  mediaType?: 'movie' | 'series';
  mediaFileId?: number;
  episodeId?: number;
  positionSeconds?: number;
  level?: number;
  muted?: boolean;
  trackId?: string;
  subtitleId?: string | null;
  qualityId?: string;
  paused?: boolean;
};

/** A `load`'s track picks ride the `trackId` / `subtitleId` fields: absent means no pick, a
 *  `null` subtitle is an explicit Off. An older target ignores them and picks automatically. */
export function launchTracksToWire(tracks: LaunchTracks | null): Pick<RemoteCommandInput, 'trackId' | 'subtitleId'> {
  return {
    trackId: tracks?.audioStreamIndex != null ? `audio-${tracks.audioStreamIndex}` : undefined,
    subtitleId: tracks?.subtitleId,
  };
}

/** The `load` that hands a snapshot to another device; `snapshotFromWire` is its inverse. */
export function snapshotToWire(s: PlaybackSnapshot): RemoteCommandInput {
  return {
    action: 'load',
    mediaId: s.item.mediaId,
    mediaFileId: s.item.fileId,
    episodeId: s.item.episodeId,
    positionSeconds: Math.floor(s.position),
    // Sent only when set: a server without the field rejects it (deny_unknown_fields).
    ...(s.paused && { paused: true }),
    ...launchTracksToWire(s.tracks),
  };
}

export function snapshotFromWire(cmd: RemoteCommand): PlaybackSnapshot | null {
  const fileId = cmd.mediaFileId;
  if (!fileId) return null;
  return {
    item: { fileId, mediaId: cmd.mediaId ?? 0, episodeId: cmd.episodeId },
    position: cmd.positionSeconds ?? 0,
    paused: cmd.paused === true,
    tracks: {
      fileId,
      audioStreamIndex: cmd.trackId !== undefined ? parseAudioIndex(cmd.trackId) : undefined,
      subtitleId: cmd.subtitleId,
    },
  };
}

/** Semantic-ack budget. A cold transcode start is the only slow case. */
const ACK_TIMEOUT_MS = 3_000;
const LOAD_ACK_TIMEOUT_MS = 20_000;
/** Answered by restarting the stream, so the first report is a cold transcode away: `next` remounts on another file, `quality` reloads. */
const SLOW_ACK_ACTIONS: ReadonlySet<RemoteAction> = new Set<RemoteAction>([
  'load',
  'next',
  'quality',
]);
/** Matches the Cast sender's window so a drag emits a handful of POSTs, not one per input event. */
const DISPATCH_COALESCE_MS = 220;
const SELECTED_TARGET_KEY = 'fliks.remote.target';
/** How long a freshly selected target is assumed to maybe be playing, before
 *  its silence is taken as "idle". */
const FIRST_REPORT_GRACE_MS = 12_000;
/** How long an unlisted target stays selected; longer than the 30s max SSE reconnect backoff, since a target riding it out is still there. */
const OFFLINE_RELEASE_MS = 45_000;

const browseKey = (c: { mediaId?: number; episodeId?: number }) => `${c.mediaId}:${c.episodeId ?? ''}`;

/** Both halves of the remote-control protocol.
 * As controllee it validates incoming commands (expiry and unknown-action guards live only here); as controller it owns targets, selection and optimistic state. */
@Injectable({ providedIn: 'root' })
export class RemoteService {
  private readonly http = inject(HttpClient);
  private readonly sse = inject(SseService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly castSettings = inject(CastSettingsService);
  private readonly cast = inject(CastService);
  private readonly translate = inject(TranslateService);

  // ── Controllee ──

  /** Commands that passed validation, for the player to apply. */
  readonly validated = new Subject<RemoteCommand>();
  /** Last command this device actually applied: rides the heartbeat as the ack. */
  readonly lastAppliedCmdId = signal<string | null>(null);

  // ── Controller ──

  readonly targets = signal<RemoteTarget[]>([]);
  readonly selectedTargetId = signal<string | null>(null);
  /** Read back from storage; becomes the selection only once a listing confirms the device is online. */
  private restoredTargetId: string | null = this.readSelectedTarget();
  readonly pendingAction = signal<RemoteAction | null>(null);
  /** Target is rebuilding its stream at the same place; derived from the command in flight so it closes with the ack. */
  readonly restarting = computed(() => this.pendingAction() === 'quality');
  readonly targetOffline = signal(false);
  private offlineTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last listing of the selected target; keeps the offline card (the way to release it) reachable after it drops off the listing. */
  private readonly selectedRow = signal<RemoteTarget | null>(null);

  readonly selectedTarget = computed(() => {
    const id = this.selectedTargetId();
    if (!id) return null;
    return this.targets().find((t) => t.targetId === id) ?? this.selectedRow();
  });
  /** A selection, not its live listing: an offline target stays selected so the overlay shows that instead of unmounting. */
  readonly isRemoting = computed(() => this.selectedTargetId() !== null);

  private stateAt = 0;
  /** The session a stop retired, so only its own farewell heartbeat is ignored. */
  private stoppedSessionId: string | null = null;
  /** Set by a stop until the target reports again: the listing can still carry
   *  the ended session until the server expires it. */
  private stoppedUntilReport = false;
  private observingSince = 0;
  private expectedMediaFileId: number | null = null;
  /** The detail page a browse just opened here, so mirroring it back to our
   *  own target cannot ping-pong between two devices controlling each other. */
  private appliedBrowseKey: string | null = null;
  private readonly reportedState = signal<RemoteNowPlaying | null>(null);
  private readonly pinnedVolume = signal<number | null>(null);
  private volumePinAt = 0;
  /** Optimistic hold for a seek: the target reads its position back only once the seek lands. */
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

  /** Drops the target's old state and names the expected file, so neither the previous title nor the old session's farewell heartbeat stands in. */
  noteLoadSent(mediaFileId: number | null): void {
    this.expectedMediaFileId = mediaFileId;
    this.stoppedSessionId = null;
    this.stoppedUntilReport = false;
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
      // Same title and position: the stream is being rebuilt, so keep the reading and show it loading.
      return;
    }
    if (pending && SLOW_ACK_ACTIONS.has(pending)) {
      // A load or a next moves to another file, so what is on screen no longer
      // describes anything: name what is coming instead.
      this.noteLoadSent(null);
      return;
    }
    this.noteStopSent();
  }

  /** Names the exact stopped session (not a time window) so its farewell heartbeat isn't mistaken for live playback; read before clearing state. */
  noteStopSent(): void {
    // Kept when the state is already gone: a stop cleared up front is noted twice.
    this.stoppedSessionId = this.reportedState()?.sessionId ?? this.stoppedSessionId;
    this.stoppedUntilReport = true;
    this.expectedMediaFileId = null;
    this.pinnedPosition.set(null);
    this.reportedState.set(null);
    this.pendingAction.set(null);
  }

  /** A selected target that has yet to report and could still be playing: a restored selection has no state, and the server join can lag a reconnect. */
  readonly awaitingFirstReport = computed(() => {
    if (!this.selectedTargetId() || this.reportedState()) return false;
    return this.wallClock() - this.observingSince < FIRST_REPORT_GRACE_MS;
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

    // Before the ticker's: the grace window it measures starts here.
    effect(() => {
      const id = this.selectedTargetId();
      untracked(() => {
        this.observingSince = id ? Date.now() : 0;
      });
    });

    effect(() => {
      this.reportedState();
      this.selectedTargetId();
      untracked(() => this.syncTicker());
    });

    // A reconnect remints the connection id, so a list built from live
    // connections is stale: refetch on our own reconnect too.
    effect(() => {
      if (!this.sse.connectionId()) return;
      untracked(() => void this.refreshTargets());
    });

    // Driven off the router, not a component effect, so every entry path (grid, search, deep link) mirrors.
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => this.mirrorRoute(e.urlAfterRedirects));
  }

  /** `/movies/:id`, `/series/:id` and `/series/:id/episode/:ep` are the mirrored
   *  detail routes; anything else on the controller is its own to browse. */
  private mirrorRoute(url: string): void {
    if (!this.selectedTargetId()) return;
    // A load in flight means the target isn't on /watch yet; `applyBrowse` would pull it back to the detail page.
    const pending = this.pendingAction();
    if (pending && SLOW_ACK_ACTIONS.has(pending)) return;
    const m = /^\/(movies|series)\/(\d+)(?:\/episode\/(\d+))?/.exec(url.split('?')[0]);
    if (!m) return;
    void this.browse({
      mediaId: Number(m[2]),
      mediaType: m[1] === 'series' ? 'series' : 'movie',
      episodeId: m[3] ? Number(m[3]) : undefined,
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
    if (cmd.action === 'browse') {
      void this.applyBrowse(cmd);
      return;
    }
    this.validated.next(cmd);
  }

  private isKnownAction(action: string): action is RemoteAction {
    return [
      'load', 'play', 'pause', 'playpause', 'stop',
      'seek', 'volume', 'mute', 'next', 'audio', 'subtitle', 'quality', 'browse',
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
    // Only an on-screen player needs the bounce to remount; elsewhere it would flash the home page.
    const overPlayer = this.router.url.startsWith('/watch');
    if (overPlayer) await this.router.navigateByUrl('/', { skipLocationChange: true });
    await this.router.navigate(['/watch', cmd.mediaFileId], {
      queryParams,
      replaceUrl: overPlayer,
      state: { snapshot: snapshotFromWire(cmd) },
    });
  }

  /** Never over a player: a controller browsing while the target plays must
   *  not kick the target out of its film. */
  private async applyBrowse(cmd: RemoteCommand): Promise<void> {
    if (!cmd.mediaId || !cmd.mediaType) {
      console.warn('[remote] browse without a media', cmd.cmdId);
      return;
    }
    if (this.router.url.startsWith('/watch')) return;
    this.appliedBrowseKey = browseKey(cmd);
    const base = cmd.mediaType === 'series' ? '/series' : '/movies';
    const path = cmd.episodeId ? [base, cmd.mediaId, 'episode', cmd.episodeId] : [base, cmd.mediaId];
    await this.router.navigate(path);
  }

  /** Controller side of `applyBrowse`: fire-and-forget, so a failed browse doesn't flip `targetOffline` or toast.
   * A stale connection id on SSE reconnect gets one re-resolve. */
  async browse(input: Omit<RemoteCommandInput, 'action'>, retry = true): Promise<void> {
    const targetId = this.selectedTargetId();
    if (!targetId) return;
    const key = browseKey(input);
    if (key === this.appliedBrowseKey) {
      this.appliedBrowseKey = null;
      return;
    }
    try {
      await firstValueFrom(
        this.http.post<{ cmdId: string }>(
          `/api/remote/${encodeURIComponent(targetId)}/command`,
          { ...input, action: 'browse', byTargetId: this.sse.targetId() },
          { context: new HttpContext().set(SKIP_ERROR_TOAST, true) },
        ),
      );
    } catch (err) {
      if (retry && err instanceof HttpErrorResponse && err.status === 404) {
        await this.refreshTargets();
        if (this.targets().some((t) => t.targetId === targetId)) {
          return this.browse(input, false);
        }
      }
      console.warn('[remote] browse failed', targetId, err);
    }
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
      // Only a household row carries an owner name; the selected target survives the filter, or it would read as offline.
      const selected = this.selectedTargetId();
      this.targets.set(
        this.castSettings.settings().showHouseholdTargets
          ? rows
          : rows.filter((r) => !r.ownerUsername || r.targetId === selected),
      );
      const listed = selected ? rows.find((r) => r.targetId === selected) : undefined;
      if (selected && !listed) {
        this.markOffline(selected);
      } else if (selected) {
        this.selectedRow.set(listed ?? null);
        this.clearOffline();
        // The target's farewell heartbeat lands after any local clear; a silent target the listing shows empty has stopped (live playback reports every 10s).
        // The listing is the only state a client that just picked an already-playing target has.
        if (!listed?.nowPlaying) this.stoppedUntilReport = false;
        if (listed?.nowPlaying && !this.reportedState() && !this.stoppedUntilReport) {
          this.reportedState.set(listed.nowPlaying);
          this.stateAt = Date.now();
        }
        const silentFor = Date.now() - this.stateAt;
        if (listed && !listed.nowPlaying && this.reportedState() && silentFor > 15_000) {
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
    // One destination at a time: a Cast session left behind a remote target would play with nothing on screen to reach it.
    if (targetId && this.cast.isConnected()) this.cast.disconnect();
    this.selectedTargetId.set(targetId);
    this.reportedState.set(null);
    this.stoppedUntilReport = false;
    this.selectedRow.set(null);
    this.clearOffline();
    this.expectedMediaFileId = null;
    // Reports from a deselected target are dropped, so its pending ack can never land.
    this.pendingCmdId = null;
    this.pendingAction.set(null);
    if (this.ackTimer) clearTimeout(this.ackTimer);
    try {
      if (targetId) localStorage.setItem(SELECTED_TARGET_KEY, targetId);
      else localStorage.removeItem(SELECTED_TARGET_KEY);
    } catch { /* blocked storage: selection is per-session only */ }

  }

  /** Absent from a listing or a command it never took: one countdown covers both. A powered-off device never returns under the same id (nonce per tab), so offer the local fallback, then release. */
  private markOffline(targetId: string): void {
    this.targetOffline.set(true);
    console.warn('[remote] selected target is offline', targetId);
    if (this.offlineTimer) return;
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = null;
      if (this.selectedTargetId() !== targetId || !this.targetOffline()) return;
      console.warn('[remote] releasing a target that stayed offline', targetId);
      this.selectTarget(null);
      this.toast.error(this.translate.instant('remote.released_offline'));
    }, OFFLINE_RELEASE_MS);
  }

  private clearOffline(): void {
    this.targetOffline.set(false);
    if (this.offlineTimer) {
      clearTimeout(this.offlineTimer);
      this.offlineTimer = null;
    }
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
    // Clear the outgoing reading and name the file BEFORE the POST: a warm target heartbeats the new file within the round-trip.
    // `next` moves to another file; a quality change keeps file and position.
    if (input.action === 'load' || input.action === 'next') {
      this.noteLoadSent(input.action === 'load' ? input.mediaFileId ?? null : null);
    }
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
      this.markOffline(targetId);
      console.warn('[remote] command failed', input.action, targetId, err);
      // The interceptor already toasts HTTP failures with the server's reason; stay silent on statuses it skips.
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
      return;
    }
    this.stoppedSessionId = null;
    this.stoppedUntilReport = false;
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
      fanartUrl: s.fanartUrl,
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
    this.clearOffline();
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

  /** Interpolates only while playing; the second clause covers the grace window before the target's first report. */
  private syncTicker(): void {
    const playing =
      this.reportedState()?.state === 'playing' ||
      (this.selectedTargetId() !== null &&
        !this.reportedState() &&
        Date.now() - this.observingSince < FIRST_REPORT_GRACE_MS);
    if (playing && this.tickHandle === null) {
      // Nothing re-runs the owning effect while the target stays silent, so the
      // tick re-checks itself out of the grace window.
      this.tickHandle = setInterval(() => {
        this.wallClock.set(Date.now());
        if (!this.reportedState()) this.syncTicker();
      }, 500);
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
