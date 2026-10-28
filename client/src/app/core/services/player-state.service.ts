import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { TranslateService } from '@ngx-translate/core';
import { pausedFlagForState, type PlaybackEngine } from './playback-engine/playback-engine';
import {
  classifyPlaybackError,
  isNetworkOrAbort,
  isUndecodableError,
  userMessageKeyFor,
  type PlaybackError,
} from './playback-engine/playback-error';
import type { PlaybackMode } from '../utils/player.utils';
import { translatedServerMessage } from '../utils/server-message';

/** localStorage key for the persisted output level (a bare 0..1 number). */
const VOLUME_KEY = 'player.volume';

/** Shared playback state signals; call `bindEngine()` after creating or switching the engine to keep them updated. */
@Injectable({ providedIn: 'root' })
export class PlayerStateService {
  readonly loading = signal(true);
  readonly videoStarted = signal(false);
  readonly error = signal<PlaybackError | null>(null);
  /** Stream-level decode/format failure a fresh session can't fix (see {@link isUndecodableError}); stops the stall watchdog's recovery loop. */
  readonly fatalNoRetry = signal(false);
  readonly paused = signal(true);
  /** In flight until the engine reports `playing`, the viewer pauses or launch fails; engines report `paused`/`buffering` before playing. */
  readonly startingPlayback = signal(true);
  /** Set when the browser refused to start playback without a user gesture, and
   *  cleared as soon as anything actually plays. */
  readonly autoplayBlocked = signal(false);
  /** The transport the viewer sees: never paused mid-launch unless refused. */
  readonly uiPaused = computed(
    () => this.paused() && (!this.startingPlayback() || this.autoplayBlocked()),
  );
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  /** Raw output level (0..1), independent of {@link muted} so unmuting recovers it; restored from localStorage. */
  readonly volume = signal(this.loadVolume());
  /** Mute flag, mirrored from the engine. Intentionally NOT persisted — a new
   *  session starts unmuted so the player never opens on an unexplained silence. */
  readonly muted = signal(false);
  readonly playbackRate = signal(1);
  readonly buffering = signal(false);
  readonly bufferedEnd = signal(0);
  /** Latched at the natural end of the stream, cleared by {@link reset} on next load; the player auto-advances the queue on it. */
  readonly ended = signal(false);
  readonly playbackMode = signal<PlaybackMode>('direct');
  readonly hwAccel = signal('none');

  /** True during a seek gesture or the short window where the engine still emits `timeUpdate` for the old position;
   * the engine-to-state mirror then ignores `position` so the seekbar stays pinned. */
  readonly seekLocked = signal(false);

  private readonly translate = inject(TranslateService);
  private engine: PlaybackEngine | null = null;

  /** Last playhead seen on `timeUpdate`; a moving playhead while not paused clears a latched buffering spinner. */
  private lastBufferingPos = -1;
  /** Widest playhead step between two `timeUpdate`s of real playback (1 s ticks at up to 2x); a longer one is a seek or a
   *  reloaded stream landing on its start position, not frames flowing. */
  private static readonly MAX_PLAYBACK_STEP = 3;

  /** Set while lost-session recovery reloads the engine; its transient fatal error then surfaces as buffering, not the error overlay. Owned by PlayerComponent. */
  private recovering = false;

  /** Read at error time, not cached, so a mid-session play-method change is reflected. Registered once by PlayerComponent. */
  private dolbyVisionProbe: (() => boolean) | null = null;

  /** Levels the voice ducker wrote (x1000), so their async `volumechange` is not saved as the user's level. */
  private readonly duckWrites = new Set<number>();

  noteDuckWrite(level: number): void {
    if (this.duckWrites.size > 40) this.duckWrites.clear();
    this.duckWrites.add(Math.round(level * 1000));
  }

  constructor() {
    // Persist the level (not the mute flag) whenever it changes, so it carries
    // across reloads and navigations.
    effect(() => {
      const v = this.volume();
      try {
        localStorage.setItem(VOLUME_KEY, String(v));
      } catch { /* storage unavailable (private mode) — volume stays session-only */ }
    });
  }

  private loadVolume(): number {
    try {
      const raw = localStorage.getItem(VOLUME_KEY);
      if (raw != null) {
        const v = parseFloat(raw);
        if (isFinite(v)) return Math.min(1, Math.max(0, v));
      }
    } catch { /* ignore */ }
    return 1;
  }

  setRecovering(value: boolean): void {
    this.recovering = value;
    if (value) {
      this.error.set(null);
    } else if (!this.error()) {
      // Recovered without a new error: drop the previous fatal classification.
      this.fatalNoRetry.set(false);
    }
  }

  setDolbyVisionProbe(probe: (() => boolean) | null): void {
    this.dolbyVisionProbe = probe;
  }

  /** Sets the error card from a translated line plus diagnostics; the only writer, so fatal-no-retry classification stays in one place. */
  setError(
    userMessage: string,
    extra?: Partial<Omit<PlaybackError, 'userMessage'>>,
  ): void {
    const err: PlaybackError = {
      userMessage,
      source: extra?.source ?? 'engine',
      ...extra,
    };
    this.error.set(err);
    this.fatalNoRetry.set(isUndecodableError(err));
  }

  /** Classify a caught error and set it as the error card; returns the translated line.
   *  `source` overrides classification for a synthetic (non-exception) failure. */
  failWith(
    e: unknown,
    opts?: { dolbyVision?: boolean; source?: PlaybackError['source'] },
  ): string {
    const classified = classifyPlaybackError(e);
    const source = opts?.source ?? classified.source;
    const code = classified.code;
    const err = e as { category?: number; severity?: number; data?: unknown[]; message?: string } | null | undefined;
    // The server's reason (missing file, no root folder) says more than a generic line.
    const userMessage =
      (e instanceof HttpErrorResponse ? translatedServerMessage(e.error?.message, this.translate) : null) ??
      this.translate.instant(
        userMessageKeyFor({ source, code, category: err?.category, dolbyVision: opts?.dolbyVision }),
      );
    this.setError(userMessage, {
      source,
      code,
      category: err?.category,
      severity: err?.severity,
      data: err?.data,
      message: err?.message ?? (e == null ? undefined : String(e)),
    });
    return userMessage;
  }

  /** Bind a playback engine's events to our signals. Call this when the engine changes. */
  bindEngine(engine: PlaybackEngine): void {
    this.engine = engine;

    engine.on('volumechange', (e) => {
      // A party ducking write is not the user's level.
      if (!this.duckWrites.delete(Math.round(e.volume * 1000))) this.volume.set(e.volume);
      this.muted.set(e.muted);
    });

    // Push the level/mute onto the new engine so it doesn't play at its own default while the slider shows another value.
    engine.volume = this.volume();
    engine.muted = this.muted();

    engine.on('stateChanged', (e) => {
      if (this.reloads > 0 && (e.state === 'idle' || e.state === 'paused' || e.state === 'playing')) return;
      const paused = pausedFlagForState(e.state);
      if (paused !== undefined) this.paused.set(paused);
      if (e.state === 'playing' || e.state === 'error' || e.state === 'ended') {
        this.startingPlayback.set(false);
      }
      // Never latch while paused: the only clear path needs an advancing playhead, so the spinner would hide the play button.
      const buffering =
        (e.state === 'buffering' || (this.recovering && e.state === 'error')) &&
        !this.paused();
      // Anchor the playhead as buffering begins so the clear fires on real progress, not the jump from a seek into the stall.
      if (buffering && !this.buffering()) {
        this.lastBufferingPos = this.engine?.currentTime ?? this.lastBufferingPos;
      }
      this.buffering.set(buffering);
      // Only a generic fallback: the `error` event (below) fires alongside
      // this and already set the detailed PlaybackError, so don't clobber it.
      if (e.state === 'error' && !this.recovering && !this.error()) {
        this.error.set({
          userMessage: this.translate.instant('player.playback_error'),
          source: 'engine',
        });
      }
      // videoStarted is not flipped here: 'playing' fires on play(), before the first frame; PlayerComponent flips it on the engine 'firstFrame' event.
    });

    engine.on('ended', () => {
      this.ended.set(true);
    });

    engine.on('timeUpdate', (e) => {
      if (!this.seekLocked()) this.currentTime.set(e.position);
      if (e.duration > 0) this.duration.set(e.duration);
      this.bufferedEnd.set(e.buffered);
      // Some engines (iOS AVPlayer after a re-buffer) never emit 'playing', so a moving playhead is what clears the spinner.
      if (
        this.reloads === 0 &&
        !this.seekLocked() &&
        !this.paused() &&
        this.buffering() &&
        e.position > this.lastBufferingPos &&
        e.position - this.lastBufferingPos <= PlayerStateService.MAX_PLAYBACK_STEP
      ) {
        this.buffering.set(false);
      }
      this.lastBufferingPos = e.position;
    });

    engine.on('error', (e) => {
      if (this.recovering) {
        this.buffering.set(true);
        return;
      }
      this.startingPlayback.set(false);
      const source = e.source ?? 'engine';
      // A DV passthrough decode failure wins over everything (even a platform errorKey); otherwise the engine's i18n key, else a source/code/category message.
      // The raw fields are kept for diagnostics regardless.
      const dvFailure =
        (this.dolbyVisionProbe?.() ?? false) &&
        !isNetworkOrAbort({ source, code: e.code, category: e.category });
      const userMessage = dvFailure
        ? this.translate.instant('player.dolby_vision_decode_failed')
        : e.errorKey
          ? this.translate.instant(e.errorKey)
          : this.translate.instant(
              userMessageKeyFor({ source, code: e.code, category: e.category }),
            );
      this.setError(userMessage, {
        source,
        code: e.code,
        category: e.category,
        severity: e.severity,
        data: e.data,
        variant: e.variant,
        message: e.message,
      });
    });
  }

  private reloads = 0;
  /** An engine reload is in flight: the engine's state is the old stream's, not yet the one being loaded. */
  readonly reloading = signal(false);

  /** Brackets an engine reload: the old stream's tail and the teardown report `playing`/`idle`/`paused`, none of
   *  them the viewer's choice, so the spinner holds, past the end of the load too, until playback resumes. Returns
   *  the end callback. */
  beginReload(): () => void {
    this.reloads++;
    this.reloading.set(true);
    this.buffering.set(true);
    return () => {
      if (--this.reloads > 0) return;
      this.reloading.set(false);
      this.buffering.set(!this.paused());
    };
  }

  /** Reset all signals for a new playback session. */
  reset(): void {
    this.loading.set(true);
    this.videoStarted.set(false);
    this.error.set(null);
    this.fatalNoRetry.set(false);
    this.paused.set(true);
    this.startingPlayback.set(true);
    this.currentTime.set(0);
    this.duration.set(0);
    this.buffering.set(false);
    this.bufferedEnd.set(0);
    this.ended.set(false);
    this.seekLocked.set(false);
    this.lastBufferingPos = -1;
  }

  getEngine(): PlaybackEngine | null {
    return this.engine;
  }
}
