import type { PlaybackEngine } from '../../core/services/playback-engine/playback-engine';
import type { QoeRecoveryReason } from '../../core/services/api/qoe-api.service';
import type { PlaybackError } from '../../core/services/playback-engine/playback-error';

/** What the controller needs from the player, so it never reaches into the component directly. */
export interface RecoveryHost {
  engine(): PlaybackEngine | null;
  isDestroyed(): boolean;
  isCasting(): boolean;
  isOnline(): boolean;
  hasMedia(): boolean;
  isPaused(): boolean;
  isLoading(): boolean;
  fatalNoRetry(): boolean;
  /** A user reload (switch, episode swap, far seek) owns the engine. */
  reloadInFlight(): boolean;
  lastSeekAt(): number;
  /** Playhead to resume from: the engine's, else the last mirrored one. */
  resumePosition(): number;
  setRecovering(recovering: boolean): void;
  hasError(): boolean;
  failWith(e: unknown, opts?: { source?: PlaybackError['source'] }): void;
  /** Mint a fresh session and reload the engine at `pos`. */
  reloadSession(pos: number): Promise<unknown>;
  /** Refresh the stream token, then warm the live session; best effort. */
  warmSession(): Promise<void>;
  /** Push one heartbeat now. */
  beat(): Promise<void>;
  /** Stall bookkeeping on the QoE session. */
  dropStall(): number | null;
  closeStall(): boolean;
  reportRecovery(position: number, wait?: { reason: QoeRecoveryReason; durationMs: number }): void;
  /** Buffering right after a reload or recovery settles is not a stall. */
  graceAfterReload(): void;
}

/** A 1 s tick this late means the process was frozen (sleep, throttled tab); `visibilitychange` doesn't
 *  fire for a sleep, so the clock gap is the signal. */
const WAKE_GAP_MS = 5_000;
const STALL_TIMEOUT_MS = 15_000;
/** A backward seek can trigger a 10-30s backend respawn with a frozen-but-healthy playhead. */
const SEEK_STALL_GRACE_MS = 32_000;
const MAX_RECOVER_ATTEMPTS = 3;
const RECOVER_CONFIRM_MS = 5_000;
const RESUME_RETRY_MS = 5_000;

/** Stall watchdog, lost-session recovery with backoff, offline parking with one in-place retry, and the
 *  wake-gap resume. Driven by the player's 1 s tick. */
export class RecoveryController {
  /** Only one recovery at a time, so a slow one can't race the next heartbeat's `sessionLost`. */
  private recovering = false;
  /** The recovery in progress: what triggered it and when the picture froze, kept across retries. */
  private episode: { reason: QoeRecoveryReason; since: number } | null = null;
  /** Attempts in this loss episode, cleared only once a reload sustains playback, so a quick re-fail keeps
   *  counting toward the cap. */
  private attempts = 0;
  /** A recovery that found the network down: re-run on reconnect without spending an attempt. */
  private whenOnline: { reason: QoeRecoveryReason; frozenSince?: number } | null = null;
  /** Pending backoff retry between failed attempts (2s, 4s). */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** A recovery reload just resolved; counters clear after the playhead advances for the confirm window. */
  private confirmPending = false;
  private confirmAt = 0;
  /** One in-place retry per outage: if it fails too, the next recovery mints a new session. */
  private retriedInPlace = false;

  /** Last playhead position and when seen: no advance for the stall timeout while playing reloads. */
  private lastProgressPos = 0;
  private lastProgressAt = 0;

  private lastTickAt = 0;
  /** A heartbeat lost on the network (e.g. right after a wake) leaves the session state unknown; retry the
   *  resume path once online. */
  private resumeDue = false;
  private lastResumeAt = 0;

  constructor(private readonly host: RecoveryHost) {}

  /** A recovery is running: other reloads and engine errors defer to it. */
  get active(): boolean {
    return this.recovering;
  }

  /** Starts the wake-gap clock from now. */
  armClock(): void {
    this.lastTickAt = Date.now();
  }

  markResumeDue(): void {
    this.resumeDue = true;
  }

  clearEpisode(): void {
    this.episode = null;
  }

  dispose(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  /** Re-baseline the stall watchdog so the next window starts from the current playhead; call wherever the
   *  playhead legitimately jumps (load, seek, recovery). */
  resetStallWatchdog(): void {
    this.lastProgressPos = this.host.engine()?.currentTime ?? 0;
    this.lastProgressAt = Date.now();
  }

  /** Ticked once a second before {@link checkStall}; keyed off the wall clock, it detects a frozen-and-back
   *  process. */
  tickClockWatch(): void {
    const now = Date.now();
    const gap = now - this.lastTickAt;
    this.lastTickAt = now;
    if (gap > WAKE_GAP_MS) {
      // A frozen interval is not a frozen playhead: skip the stall watchdog's black-screen reload this tick.
      this.resetStallWatchdog();
      void this.resumeAfterGap();
    } else if (this.whenOnline && this.host.isOnline()) {
      const { reason, frozenSince } = this.whenOnline;
      this.whenOnline = null;
      void this.recoverFromLostSession(reason, frozenSince, true);
    } else if (this.resumeDue && this.host.isOnline() && now - this.lastResumeAt >= RESUME_RETRY_MS) {
      void this.resumeAfterGap();
    }
  }

  /** The player was frozen (sleep) or cut off and is back; the backend killed our encoder but knows the sid.
   *  Refresh the token, re-fetch the manifest at the playhead (respawns ffmpeg), beat once; no engine reload. */
  async resumeAfterGap(): Promise<void> {
    if (this.host.isDestroyed() || !this.host.hasMedia()) return;
    if (this.host.isCasting()) return;
    if (!this.host.isOnline()) {
      this.resumeDue = true;
      return;
    }
    this.resumeDue = false;
    this.lastResumeAt = Date.now();
    try {
      await this.host.warmSession();
    } catch {
      // Best effort: the heartbeat below is what actually drives recovery.
    }
    await this.host.beat();
  }

  /** Ticked once a second; detects a frozen playhead during intended playback and routes it through the
   *  lost-session recovery (re-mint sid + reload at position). */
  checkStall(): void {
    const engine = this.host.engine();
    if (this.host.isDestroyed() || !engine) return;
    if (this.host.isCasting()) return;
    // Not playing (yet): keep the baseline fresh. A fatal-no-retry error also bails: a fresh sid can't fix a
    // codec the browser rejects, so show the terminal error instead of flapping the card/spinner.
    if (
      this.host.isPaused() ||
      this.host.isLoading() ||
      this.host.fatalNoRetry() ||
      this.recovering ||
      this.host.reloadInFlight()
    ) {
      this.resetStallWatchdog();
      return;
    }
    const pos = engine.currentTime;
    const dur = engine.duration;
    if (dur && pos >= dur - 1) {
      this.resetStallWatchdog();
      return;
    }
    // Any meaningful move (forward play or a seek in either direction) counts as progress and rearms the window.
    if (Math.abs(pos - this.lastProgressPos) > 0.25) {
      this.lastProgressPos = pos;
      this.lastProgressAt = Date.now();
      // Playback sustained for the confirm window means a clean recovery: clear the counter and re-arm the
      // native one-shot guard so a later blip gets its own recovery.
      if (this.confirmPending && Date.now() - this.confirmAt >= RECOVER_CONFIRM_MS) {
        this.confirmPending = false;
        this.attempts = 0;
        this.retriedInPlace = false;
        engine.resetRecoveryGuard();
      }
      return;
    }
    const timeout =
      Date.now() - this.host.lastSeekAt() < SEEK_STALL_GRACE_MS ? SEEK_STALL_GRACE_MS : STALL_TIMEOUT_MS;
    if (Date.now() - this.lastProgressAt >= timeout) {
      const frozenSince = this.lastProgressAt;
      this.resetStallWatchdog();
      void this.recoverFromLostSession('stall', frozenSince);
    }
  }

  /** The carried `sid` is unknown to the backend or the playhead wedged: mint a fresh session and reload at the
   *  position, backing off up to the attempt cap. Skipped for Cast (receiver owns the session). */
  async recoverFromLostSession(
    reason: QoeRecoveryReason = 'other',
    frozenSince?: number,
    afterOffline = false,
  ): Promise<void> {
    if (this.host.isDestroyed()) return;
    if (this.recovering) return;
    // A user reload (quality/audio switch, episode swap) owns the session, so a 410 or sessionLost inside it is
    // expected and recovering would race a second load; also clear any veil held across a backoff.
    if (this.host.reloadInFlight()) {
      this.host.setRecovering(false);
      this.episode = null;
      return;
    }
    if (this.retryTimer) return; // a backoff retry is already queued
    if (this.attempts >= MAX_RECOVER_ATTEMPTS) {
      // Exhausted: surface a terminal error card rather than leave a stuck spinner or stale overlay.
      this.giveUp();
      return;
    }
    if (this.host.isCasting()) return;
    const engine = this.host.engine();
    if (!engine || !this.host.hasMedia()) return;
    if (!this.host.isOnline()) {
      this.retriedInPlace = false;
      this.whenOnline ??= { reason, frozenSince };
      this.host.setRecovering(true);
      return;
    }
    // The server keeps the session through a short outage: re-prepare the loaded stream, keeping the last frame up.
    if (afterOffline && !this.retriedInPlace && engine.retry) {
      this.recovering = true;
      try {
        if (await engine.retry()) {
          this.retriedInPlace = true;
          this.awaitConfirm();
          return;
        }
      } finally {
        this.recovering = false;
      }
    }
    // The first trigger names the episode. An open stall already counts the freeze on the old sid, so the wait
    // starts now; otherwise at the last progress. A lost sid's open stall moves to the new one.
    if (!this.episode) {
      const openSince = reason === 'session_lost' ? this.host.dropStall() : null;
      const counted = openSince == null && this.host.closeStall();
      const since =
        openSince ??
        (counted ? Date.now() : Math.min(Date.now(), frozenSince ?? (this.lastProgressAt || Date.now())));
      this.episode = { reason, since };
    }
    this.recovering = true;
    // Suppress the fatal-error overlay the engine tears off during the reload: it should read as buffering.
    this.host.setRecovering(true);
    // Count up front, not only on failure: Shaka has no per-engine one-shot latch, so a fresh sid that 410s
    // again would re-enter at 0 and loop. Cleared only after playback sustains for the confirm window.
    this.attempts += 1;
    const pos = this.host.resumePosition();
    try {
      await this.host.reloadSession(pos);
      const episode = this.episode;
      this.episode = null;
      this.host.reportRecovery(
        pos,
        episode ? { reason: episode.reason, durationMs: Date.now() - episode.since } : undefined,
      );
      this.awaitConfirm();
    } catch (e) {
      if (!this.host.isOnline()) {
        this.attempts -= 1;
        this.whenOnline ??= { reason };
      } else if (this.attempts >= MAX_RECOVER_ATTEMPTS) {
        this.giveUp(e);
      } else {
        // Hold the recovering veil up across the backoff so the user sees a reconnect, not a flash of the
        // fatal overlay between attempts.
        const backoff = 2_000 * 2 ** (this.attempts - 1); // 2s, 4s
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.recoverFromLostSession(reason);
        }, backoff);
      }
    } finally {
      this.recovering = false;
      this.host.graceAfterReload();
    }
  }

  /** Keeps the episode counter until the recovered stream proves it plays ({@link checkStall} confirms), so a
   *  re-fail keeps counting. */
  private awaitConfirm(): void {
    this.resetStallWatchdog();
    this.host.setRecovering(false);
    this.confirmPending = true;
    this.confirmAt = Date.now();
  }

  /** The terminal card means playback is over: an engine left loaded would keep buffering and play on behind
   *  it once the network comes back. */
  private giveUp(e?: unknown): void {
    this.episode = null;
    this.host.setRecovering(false);
    void this.host.engine()?.unload();
    if (e !== undefined) this.host.failWith(e);
    else if (!this.host.hasError()) this.host.failWith(undefined, { source: 'session' });
  }
}
