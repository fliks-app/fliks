import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import { NavigationEnd, Router } from '@angular/router';
import type { MediaType } from '../enums/media-type.enum';
import { Subject, filter, firstValueFrom } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { RemoteCommand, RemoteState, SseService, type WireQueue } from './sse.service';
import { SKIP_ERROR_TOAST } from '../interceptors/error.interceptor';
import { ToastService } from './toast.service';
import { CastSettingsService } from './cast-settings.service';
import { CastService } from './cast.service';
import { SessionSyncService } from './session-sync.service';
import { deviceIdOf, sameTarget } from './remote-target-id';
import type { LaunchTracks } from './track-manager.service';
import { parseAudioIndex } from '../utils/player.utils';
import { projectPosition } from '../utils/position-anchor';
import type { PlaybackSnapshot } from './playback/playback-output';
import { DETAIL_SEGMENTS_PATTERN, KIND_REGISTRY, isMediaKind, kindFromSegment, kindOf, type MediaFamily } from '../media-kinds';

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
  /** What a polled target applies; absent means everything. `resume` is a `load` of the file it already plays. */
  actions?: string[];
}

/** Whether a target takes `action`: one that declared no `actions` takes everything. */
export function targetSupports(target: RemoteTarget | null | undefined, action: RemoteAction | 'resume'): boolean {
  return !target?.actions || target.actions.includes(action);
}

/** The listed face of `id`: the exact row, else the same device's `#native` face or web tab (the server's `continues` rule). */
export function faceOf(rows: readonly RemoteTarget[], id: string): RemoteTarget | undefined {
  return rows.find((t) => t.targetId === id) ?? rows.find((t) => sameTarget(t.targetId, id));
}

/** Whether `target` takes a `load`, as the server decides: `resume` stands for the file the account row says it holds. */
export function targetCanLoad(target: RemoteTarget | null | undefined, holdsFile: boolean): boolean {
  return targetSupports(target, 'load') || (holdsFile && targetSupports(target, 'resume'));
}

/** The reading a load or next clears, kept to give back when the target refuses it. */
interface ReadingSnapshot {
  reported: RemoteNowPlaying | null;
  pinned: number | null;
  stoppedSessionId: string | null;
  stoppedUntilReport: boolean;
  observingSince: number;
}

/** Payload of a command, minus what the server stamps. */
export type RemoteCommandInput = {
  action: RemoteAction;
  mediaId?: number;
  mediaType?: MediaType;
  mediaFileId?: number;
  episodeId?: number;
  itemId?: number;
  positionSeconds?: number;
  level?: number;
  muted?: boolean;
  trackId?: string;
  subtitleId?: string | null;
  qualityId?: string;
  paused?: boolean;
  queue?: WireQueue;
  shuffle?: boolean;
  repeat?: 'off' | 'all' | 'one';
  kind?: MediaType;
  itemIds?: number[];
  where?: 'next' | 'last';
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
    ...(s.item.itemId != null && { itemId: s.item.itemId }),
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
    item: { fileId, mediaId: cmd.mediaId ?? 0, episodeId: cmd.episodeId, itemId: cmd.itemId },
    position: cmd.positionSeconds ?? 0,
    paused: cmd.paused === true,
    tracks: {
      fileId,
      audioStreamIndex: cmd.trackId !== undefined ? parseAudioIndex(cmd.trackId) : undefined,
      subtitleId: cmd.subtitleId,
    },
  };
}

/** Semantic-ack budget: a backgrounded phone acks through its 2 s command poll and its next beat. */
const ACK_TIMEOUT_MS = 6_000;
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
  private readonly sessionSync = inject(SessionSyncService);

  // ── Controllee ──

  /** Commands that passed validation, for the player to apply. */
  readonly validated = new Subject<RemoteCommand>();
  /** This phone just asked the target to start: a new selection, a load or a play. */
  readonly startedHere = new Subject<void>();
  /** Last command this device actually applied: rides the heartbeat as the ack. */
  readonly lastAppliedCmdId = signal<string | null>(null);

  // ── Controller ──

  readonly targets = signal<RemoteTarget[]>([]);
  readonly selectedTargetId = signal<string | null>(null);
  /** Read back from storage; becomes the selection only once a listing confirms the device is online. */
  private restoredTargetId: string | null = this.readSelectedTarget();
  /** The last session owner seen, through any parked gap; a selection that was it yields to the next owner. */
  private lastOwner: string | null = null;
  readonly pendingAction = signal<RemoteAction | null>(null);
  /** Target is rebuilding its stream at the same place; derived from the command in flight so it closes with the ack. */
  readonly restarting = computed(() => this.pendingAction() === 'quality');
  readonly targetOffline = signal(false);
  private offlineTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last listing of the selected target; keeps the offline card (the way to release it) reachable after it drops off the listing. */
  private readonly selectedRow = signal<RemoteTarget | null>(null);

  /** Where state is read from and commands go: the selection, else the account session's owner. Reading it hijacks nothing. */
  readonly observedTargetId = computed(() => this.selectedTargetId() ?? this.sessionSync.observedOwnerTargetId());

  readonly selectedTarget = computed(() => {
    const id = this.selectedTargetId();
    if (!id) return null;
    return this.targets().find((t) => t.targetId === id) ?? this.selectedRow();
  });
  readonly observedTarget = computed(() => {
    const id = this.observedTargetId();
    if (!id) return null;
    return faceOf(this.targets(), id) ?? (id === this.selectedTargetId() ? this.selectedRow() : null);
  });
  /** Whether the observed target takes `action`; reads the listing, so a computed over it follows. */
  observedCan(action: RemoteAction): boolean {
    return targetSupports(this.observedTarget(), action);
  }
  /** Whether `targetId` takes a `load` of `fileId`; the one check before any load is sent.
   *  The server's `holds` is by device and over every account's row; this reads the own account's only, so a household device's resume is left to the server. */
  canLoad(targetId: string, fileId: number | null | undefined): boolean {
    const held = this.sessionSync.session();
    const holds = !!fileId && !!held?.owner.targetId && deviceIdOf(held.owner.targetId) === deviceIdOf(targetId) && held.item.mediaFileId === fileId;
    return targetCanLoad(faceOf(this.targets(), targetId), holds);
  }
  /** A selection, not its live listing: an offline target stays selected so the overlay shows that instead of unmounting. */
  readonly isRemoting = computed(() => this.selectedTargetId() !== null);
  /** Following a device, selected or not; only a selection sends this device's next plays there. */
  readonly isObserving = computed(() => this.observedTargetId() !== null);

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
  /** Bumped when the reading is cleared for a load; a refusal gives back only the reading its own load cleared. */
  private loadSeq = 0;
  /** Bumped by every position pin; a refusal unpins only a pin nothing newer replaced. */
  private pinSeq = 0;
  private tickHandle: ReturnType<typeof setInterval> | null = null;

  /** The target's own report is authoritative; between reports the position is
   *  extrapolated from its ARRIVAL time, so there is no clock to synchronise. */
  readonly interpolatedPosition = computed(() => {
    const s = this.reportedState();
    const pinned = this.pinnedPosition();
    const position = pinned ?? s?.positionSeconds ?? 0;
    if (!s) return position;
    const at = pinned !== null ? this.positionPinAt : this.stateAt;
    return projectPosition({ position, at, playing: s.state === 'playing', duration: s.durationSeconds || null, rate: s.playbackRate }, this.wallClock());
  });
  readonly targetState = computed(() => {
    const s = this.reportedState();
    const pinned = this.pinnedVolume();
    if (!s || pinned === null) return s;
    return { ...s, volume: pinned };
  });

  /** Drops the target's old state and names the expected file, so neither the previous title nor the old session's farewell heartbeat stands in. */
  noteLoadSent(mediaFileId: number | null): void {
    this.loadSeq++;
    this.expectedMediaFileId = mediaFileId;
    this.stoppedSessionId = null;
    this.stoppedUntilReport = false;
    this.pinnedPosition.set(null);
    this.reportedState.set(null);
    this.observingSince = Date.now();
  }

  /** A refused command left the target as it was: a load drops its expectation and the listing reseeds the reading; a seek lets go of its pin.
   *  Each acts only while no later command owns that part, and only on the target it was sent to. */
  private revertRefused(targetId: string, input: RemoteCommandInput, loadSeq: number, pinSeq: number, before: ReadingSnapshot | null): void {
    if (targetId !== this.observedTargetId()) return;
    if (input.action === 'seek' && pinSeq === this.pinSeq) this.pinnedPosition.set(null);
    if (before && loadSeq === this.loadSeq) {
      this.expectedMediaFileId = null;
      this.reportedState.set(before.reported);
      this.pinnedPosition.set(before.pinned);
      this.stoppedSessionId = before.stoppedSessionId;
      this.stoppedUntilReport = before.stoppedUntilReport;
      this.observingSince = before.observingSince;
      void this.refreshTargets(true);
    }
  }

  private readingSnapshot(): ReadingSnapshot {
    return {
      reported: this.reportedState(),
      pinned: this.pinnedPosition(),
      stoppedSessionId: this.stoppedSessionId,
      stoppedUntilReport: this.stoppedUntilReport,
      observingSince: this.observingSince,
    };
  }

  /** The selected target left its player. Same treatment as a stop we sent: the
   *  reading goes, and the farewell heartbeat behind it is ignored. */
  noteTargetStopped(targetId: string, sessionId: string | null = null): void {
    if (!targetId || targetId !== this.observedTargetId()) return;
    // A target also stops sessions it does not report (a preload, a download): only the one read ends the reading.
    const read = this.reportedState()?.sessionId;
    if (sessionId && read && read !== sessionId) return;
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
    this.noteStopSent(sessionId);
  }

  /** Names the exact stopped session (not a time window) so its farewell heartbeat isn't mistaken for live playback; read before clearing state. */
  noteStopSent(sessionId: string | null = null): void {
    // Kept when the state is already gone: a stop cleared up front is noted twice.
    this.stoppedSessionId = sessionId ?? this.reportedState()?.sessionId ?? this.stoppedSessionId;
    this.stoppedUntilReport = true;
    this.expectedMediaFileId = null;
    this.pinnedPosition.set(null);
    this.reportedState.set(null);
    this.pendingAction.set(null);
  }

  /** An observed target that has yet to report and could still be playing: a restored selection has no state, and the server join can lag a reconnect.
   *  A listing that shows it playing nothing settles it: an idle device never reports. */
  readonly awaitingFirstReport = computed(() => {
    if (!this.observedTargetId() || this.reportedState()) return false;
    const row = this.observedTarget();
    if (row && !row.nowPlaying) return false;
    return this.wallClock() - this.observingSince < FIRST_REPORT_GRACE_MS;
  });

  /** Hold the level the user just set until the target confirms it, so the
   *  slider stops fighting the reports it triggers. */
  /** Hold a requested position until the target reports one that matches it. */
  private pinPosition(seconds: number): void {
    this.pinSeq++;
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
    this.sse.stopped.subscribe((e) => this.noteTargetStopped(e.targetId, e.sessionId));

    effect(() => {
      this.sse.remoteState();
      untracked(() => this.ingestState());
    });

    // Before the ticker's: the grace window it measures starts here.
    effect(() => {
      const id = this.observedTargetId();
      untracked(() => {
        this.observingSince = id ? Date.now() : 0;
      });
    });

    // A session owner taking over is a new device to read: the previous one's reading goes, the listing seeds the next.
    let observed: string | null = null;
    effect(() => {
      const id = this.observedTargetId();
      untracked(() => {
        if (id === observed) return;
        observed = id;
        if (!id || id !== this.selectedTargetId()) this.reportedState.set(null);
        if (id) void this.refreshTargets();
      });
    });

    effect(() => {
      this.reportedState();
      this.observedTargetId();
      untracked(() => this.syncTicker());
    });

    // One device per account: the selection goes when a session it owned moves to another device.
    effect(() => {
      const owner = this.sessionSync.observedOwnerTargetId();
      const selected = this.selectedTargetId();
      untracked(() => {
        if (!owner) return;
        if (selected && owner !== selected && this.lastOwner === selected) this.selectTarget(null);
        else this.lastOwner = owner;
      });
    });

    this.sessionSync.setLiveSource(
      () => {
        const s = this.targetState();
        return s ? { mediaFileId: s.mediaFileId, durationSeconds: s.durationSeconds } : null;
      },
      () => this.interpolatedPosition(),
    );

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
    const m = new RegExp(`^/(${DETAIL_SEGMENTS_PATTERN})/(\\d+)(?:/episode/(\\d+))?`).exec(url.split('?')[0]);
    if (!m) return;
    void this.browse({
      mediaId: Number(m[2]),
      mediaType: kindFromSegment(m[1]) ?? 'movie',
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
      'seek', 'volume', 'mute', 'next', 'prev', 'shuffle', 'repeat', 'queue', 'enqueue', 'audio', 'subtitle', 'quality', 'browse',
    ].includes(action);
  }

  /** Registers how a family starts a `load`; video, the default, is the `/watch` navigation below. */
  registerLoader(family: MediaFamily, loader: (cmd: RemoteCommand) => Promise<void>): void {
    this.loaders[family] = loader;
  }

  private readonly loaders: Partial<Record<MediaFamily, (cmd: RemoteCommand) => Promise<void>>> = {};

  /** The loader of the family of the item, none for video and for an older sender that names no kind. */
  private loaderFor(cmd: RemoteCommand) {
    if (!isMediaKind(cmd.kind)) return undefined;
    const family = KIND_REGISTRY[cmd.kind].families.find((f) => f !== 'video' && this.loaders[f]);
    return family && this.loaders[family];
  }

  /** `load` is the one action the player cannot own: its command effect filters
   *  on the file it already has, and an idle device has no player at all. */
  private async applyLoad(cmd: RemoteCommand): Promise<void> {
    // Only an on-screen player needs the bounce to remount; elsewhere it would flash the home page.
    const overPlayer = this.router.url.startsWith('/watch');
    const loader = this.loaderFor(cmd);
    if (loader) {
      this.lastAppliedCmdId.set(cmd.cmdId);
      if (overPlayer) await this.router.navigateByUrl('/', { replaceUrl: true });
      this.releaseSelection();
      return loader(cmd);
    }
    if (!cmd.mediaFileId) {
      console.warn('[remote] load without a mediaFileId', cmd.cmdId);
      return;
    }
    this.lastAppliedCmdId.set(cmd.cmdId);
    const queryParams: Record<string, string | number> = {};
    if (cmd.mediaId) queryParams['mediaId'] = cmd.mediaId;
    if (cmd.episodeId) queryParams['episodeId'] = cmd.episodeId;
    if (cmd.positionSeconds !== undefined) queryParams['t'] = Math.floor(cmd.positionSeconds);
    if (overPlayer) await this.router.navigateByUrl('/', { skipLocationChange: true });
    this.releaseSelection();
    await this.router.navigate(['/watch', cmd.mediaFileId], {
      queryParams,
      replaceUrl: overPlayer,
      state: { snapshot: snapshotFromWire(cmd) },
    });
  }

  /** The device plays the load itself, so it stops controlling another: a player over a selection forwards the load back. */
  private releaseSelection(): void {
    if (this.selectedTargetId()) this.selectTarget(null);
  }

  /** Never over a player: a controller browsing while the target plays must
   *  not kick the target out of its film. */
  private async applyBrowse(cmd: RemoteCommand): Promise<void> {
    if (!cmd.mediaId || !isMediaKind(cmd.mediaType)) {
      console.warn('[remote] browse without a media', cmd.cmdId);
      return;
    }
    if (this.router.url.startsWith('/watch')) return;
    this.appliedBrowseKey = browseKey(cmd);
    const base = '/' + kindOf(cmd.mediaType).segment;
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

  /** `replaceReport` takes the listing as the truth over the held report, as after a resume. */
  async refreshTargets(replaceReport = false): Promise<void> {
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
      const observed = this.observedTargetId();
      const listed = observed ? faceOf(rows, observed) : undefined;
      if (selected && !listed) {
        this.markOffline(selected);
      } else if (listed) {
        if (selected) this.selectedRow.set(listed);
        this.clearOffline();
        // The target's farewell heartbeat lands after any local clear; a silent target the listing shows empty has stopped (live playback reports every 10s).
        // The listing is the only state a client that just picked an already-playing target has.
        if (!listed.nowPlaying) this.stoppedUntilReport = false;
        if (replaceReport && !listed.nowPlaying) this.reportedState.set(null);
        if (listed.nowPlaying && (!this.reportedState() || replaceReport) && !this.stoppedUntilReport) {
          this.reportedState.set(listed.nowPlaying);
          this.stateAt = Date.now();
        }
        const reportedAt = Math.max(this.stateAt, this.sessionSync.ownerReportAt(listed.targetId));
        const silentFor = Date.now() - reportedAt;
        if (!listed.nowPlaying && this.reportedState() && silentFor > 15_000) {
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
    this.lastOwner = this.sessionSync.observedOwnerTargetId();
    if (targetId) this.startedHere.next();
    // One destination at a time: a Cast session left behind a remote target would play with nothing on screen to reach it.
    if (targetId && this.cast.isConnected()) this.cast.disconnect();
    this.selectedTargetId.set(targetId);
    this.reportedState.set(null);
    this.stoppedUntilReport = false;
    this.selectedRow.set(this.targets().find((t) => t.targetId === targetId) ?? null);
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

  async send(targetId: string, input: RemoteCommandInput): Promise<void> {
    if (input.action === 'load' && !this.canLoad(targetId, input.mediaFileId)) {
      this.toast.error(this.translate.instant('remote.error_unsupported_action'));
      return;
    }
    return this.dispatch(targetId, input, true);
  }

  private async dispatch(targetId: string, input: RemoteCommandInput, retry: boolean): Promise<void> {
    this.pendingAction.set(input.action);
    this.notePositionIntent(input);
    if (input.action === 'load' || input.action === 'play' || input.action === 'playpause') this.startedHere.next();
    // Clear the outgoing reading and name the file BEFORE the POST: a warm target heartbeats the new file within the round-trip.
    // `next` moves to another file; a quality change keeps file and position.
    const moves = input.action === 'load' || input.action === 'next';
    const before = moves ? this.readingSnapshot() : null;
    if (moves) {
      this.noteLoadSent(input.action === 'load' ? input.mediaFileId ?? null : null);
    }
    const { loadSeq, pinSeq } = this;
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
          return this.dispatch(targetId, input, false);
        }
      }
      this.pendingAction.set(null);
      // Refused, not unreachable: the interceptor toasts the reason and the target stays online.
      if (err instanceof HttpErrorResponse && err.status === 409) {
        this.revertRefused(targetId, input, loadSeq, pinSeq, before);
        console.warn('[remote] command refused', input.action, targetId);
        return;
      }
      if (err instanceof HttpErrorResponse && err.status === 404) this.markOffline(targetId);
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
    if (!s || s.targetId !== this.observedTargetId()) return;
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
      itemId: s.itemId,
      mediaTitle: s.mediaTitle,
      episodeLabel: s.episodeLabel,
      posterUrl: s.posterUrl,
      fanartUrl: s.fanartUrl,
      positionSeconds: s.positionSeconds,
      durationSeconds: s.durationSeconds,
      state: s.state,
      volume: s.volume,
      muted: s.muted,
      playbackRate: s.playbackRate,
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
      (this.observedTargetId() !== null &&
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
