import { Injectable, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import type { PlaybackEngine } from './playback-engine/playback-engine';

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
  readonly error = signal<string | null>(null);
  readonly paused = signal(true);
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly volume = signal(1);
  readonly playbackRate = signal(1);
  readonly buffering = signal(false);
  readonly bufferedEnd = signal(0);
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

  setRecovering(value: boolean): void {
    this.recovering = value;
    if (value) this.error.set(null);
  }

  /** Bind a playback engine's events to our signals. Call this when the engine changes. */
  bindEngine(engine: PlaybackEngine): void {
    this.engine = engine;

    engine.on('stateChanged', (e) => {
      this.paused.set(e.state === 'paused' || e.state === 'idle');
      this.buffering.set(e.state === 'buffering' || (this.recovering && e.state === 'error'));
      if (e.state === 'error' && !this.recovering) {
        this.error.set(this.translate.instant('player.playback_error'));
      }
      // videoStarted is intentionally NOT flipped here — Shaka emits 'playing'
      // on DOM 'play' (= play() called), well before the first frame is
      // actually painted. PlayerComponent owns the flip per engine, always via
      // the engine 'firstFrame' event: rvfc on the local <video> for Shaka,
      // ExoPlayer onRenderedFirstFrame (with an onIsPlayingChanged fallback)
      // for native.
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
      // Prefer the engine's i18n key (Tizen/webOS surface platform strings);
      // fall back to the raw message, then a generic translated error.
      this.error.set(
        e.errorKey
          ? this.translate.instant(e.errorKey)
          : e.message || this.translate.instant('player.playback_error'),
      );
    });
  }

  /** Reset all signals for a new playback session. */
  reset(): void {
    this.loading.set(true);
    this.videoStarted.set(false);
    this.error.set(null);
    this.paused.set(true);
    this.currentTime.set(0);
    this.duration.set(0);
    this.buffering.set(false);
    this.bufferedEnd.set(0);
    this.seekLocked.set(false);
    this.lastBufferingPos = -1;
  }

  getEngine(): PlaybackEngine | null {
    return this.engine;
  }
}
