import { Injectable, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import type { PlaybackEngine } from './playback-engine/playback-engine';
import {
  isNetworkOrAbort,
  isUndecodableError,
  userMessageKeyFor,
  type PlaybackError,
} from './playback-engine/playback-error';

/**
 * Shared playback state signals that any UI component can read.
 *
 * Call `bindEngine()` after creating or switching the PlaybackEngine —
 * the service listens to engine events and keeps every signal up-to-date.
 */
@Injectable({ providedIn: 'root' })
export class PlayerStateService {
  readonly loading = signal(true);
  readonly videoStarted = signal(false);
  readonly error = signal<PlaybackError | null>(null);
  /** True when the current error is a stream-level decode/format failure a
   *  fresh session cannot fix (see {@link isUndecodableError}). The stall
   *  watchdog reads it to stop looping lost-session recovery on a codec the
   *  browser can't decode — that only flaps the card/spinner. */
  readonly fatalNoRetry = signal(false);
  readonly paused = signal(true);
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly volume = signal(1);
  readonly playbackRate = signal(1);
  readonly buffering = signal(false);
  readonly bufferedEnd = signal(0);
  /** Latched when the engine reaches the natural end of the stream; cleared by
   *  {@link reset} on the next load. The player watches it to auto-advance the
   *  queue. */
  readonly ended = signal(false);
  readonly playbackMode = signal<'direct' | 'remux' | 'transcode'>('direct');
  readonly hwAccel = signal('none');

  /** True while a seek gesture is in flight — set by the player while
   *  the user drags the seekbar or holds an arrow key, and during the
   *  short window after a `seek()` call where the engine still emits
   *  intermediate `timeUpdate` events for the OLD position before it
   *  catches up to the target. While set, the engine→state mirror
   *  ignores `position` updates so the seekbar stays pinned at the
   *  user's commit value instead of bouncing back to whatever the
   *  engine reports mid-seek. */
  readonly seekLocked = signal(false);

  private readonly translate = inject(TranslateService);
  private engine: PlaybackEngine | null = null;

  /** Last playhead position seen on `timeUpdate`. A moving playhead while not
   *  paused is the reliable cross-engine "frames are flowing" signal used to
   *  clear a latched buffering spinner. */
  private lastBufferingPos = -1;

  /** True while a lost-session recovery is re-minting the sid and reloading
   *  the engine. The reload tears the current stream down, so the engine
   *  briefly emits a fatal error (Shaka's `<video>` element error, ExoPlayer's
   *  one-shot error bridge) that recovery is about to resolve. While set, that
   *  error surfaces as buffering — the spinner — instead of the terminal
   *  "Playback error" overlay. Owned by PlayerComponent's recovery flow. */
  private recovering = false;

  /** Live check for whether the current media is Dolby Vision served untouched
   *  (DirectPlay/DirectStream). Read at error time — not cached — so a mid-session
   *  play-method change (e.g. a quality switch to a tonemapped transcode) is
   *  always reflected. Registered once by PlayerComponent. */
  private dolbyVisionProbe: (() => boolean) | null = null;

  setRecovering(value: boolean): void {
    this.recovering = value;
    if (value) this.error.set(null);
  }

  setDolbyVisionProbe(probe: (() => boolean) | null): void {
    this.dolbyVisionProbe = probe;
  }

  /** Set the error card from a translated one-liner plus optional
   *  diagnostics (code / category / variant / data). Central writer so the
   *  fatal-no-retry classification stays in one place. */
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

  /** Bind a playback engine's events to our signals. Call this when the engine changes. */
  bindEngine(engine: PlaybackEngine): void {
    this.engine = engine;

    engine.on('stateChanged', (e) => {
      this.paused.set(e.state === 'paused' || e.state === 'idle');
      const buffering = e.state === 'buffering' || (this.recovering && e.state === 'error');
      // Anchor the playhead reference as buffering begins so the timeUpdate clear
      // below fires on real forward progress, not the position jump a seek into
      // the stall produces — otherwise the spinner clears before playback resumes.
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
      // videoStarted is intentionally NOT flipped here — Shaka emits 'playing'
      // on DOM 'play' (= play() called), well before the first frame is
      // actually painted. PlayerComponent owns the flip per engine, always via
      // the engine 'firstFrame' event: rvfc on the local <video> for Shaka,
      // ExoPlayer onRenderedFirstFrame (with an onIsPlayingChanged fallback)
      // for native.
    });

    engine.on('ended', () => {
      this.ended.set(true);
    });

    engine.on('timeUpdate', (e) => {
      if (!this.seekLocked()) this.currentTime.set(e.position);
      if (e.duration > 0) this.duration.set(e.duration);
      this.bufferedEnd.set(e.buffered);
      // A moving playhead while not paused means frames are flowing — clear a
      // latched buffering spinner. Some engines (notably iOS AVPlayer recovering
      // from a stall) never emit a 'playing' stateChanged after a re-buffer, so
      // the spinner would otherwise stay up over correctly-playing video.
      if (
        !this.seekLocked() &&
        !this.paused() &&
        this.buffering() &&
        e.position !== this.lastBufferingPos
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
      const source = e.source ?? 'engine';
      // A DV passthrough that fails to decode wins over everything else (even a
      // platform errorKey): tell the user Dolby Vision failed on this device.
      // Otherwise prefer the engine's explicit i18n key (Tizen/webOS surface
      // platform strings), else map source/code/category to a category message.
      // The raw fields are kept for the diagnostics block regardless.
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

  /** Reset all signals for a new playback session. */
  reset(): void {
    this.loading.set(true);
    this.videoStarted.set(false);
    this.error.set(null);
    this.fatalNoRetry.set(false);
    this.paused.set(true);
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
