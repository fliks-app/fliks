import { Injectable, signal } from '@angular/core';
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

  private engine: PlaybackEngine | null = null;

  /** Bind a playback engine's events to our signals. Call this when the engine changes. */
  bindEngine(engine: PlaybackEngine): void {
    this.engine = engine;

    engine.on('stateChanged', (e) => {
      this.paused.set(e.state === 'paused' || e.state === 'idle');
      this.buffering.set(e.state === 'buffering');
      if (e.state === 'error') this.error.set('Playback error');
      // videoStarted is intentionally NOT flipped here — Shaka emits 'playing'
      // on DOM 'play' (= play() called), well before the first frame is
      // actually painted. PlayerComponent owns the flip per engine: rvfc on
      // the local <video> for Shaka, stateChanged 'playing' for native (where
      // ExoPlayer's surface is already painting by then).
    });

    engine.on('timeUpdate', (e) => {
      if (!this.seekLocked()) this.currentTime.set(e.position);
      if (e.duration > 0) this.duration.set(e.duration);
      this.bufferedEnd.set(e.buffered);
    });

    engine.on('error', (e) => {
      this.error.set(e.message);
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
  }

  getEngine(): PlaybackEngine | null {
    return this.engine;
  }
}
