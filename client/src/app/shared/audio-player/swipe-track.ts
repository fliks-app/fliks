import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input, output, signal, type TemplateRef } from '@angular/core';
import type { AudioOutput } from '../../core/services/audio-player/audio-output';
import type { MusicTrackRequest } from '../../core/services/audio-player/music-queue';
import { SwipeSkipDirective } from '../directives/swipe-skip.directive';

/** Matches `.swipe-settle` in base-components.css. */
const SETTLE_MS = 220;
/** The neighbour's cover stays over the bar's own until that one has faded in (`.cover-in`, 250 ms). */
const COVER_HOLD_MS = 300;
const GAP = '3rem';

type Phase = 'idle' | 'drag' | 'back' | 'skip';

/** A track's title lines that swipe to the next or previous track: the neighbour follows the finger, and a release
 *  slides on to it or back. The host shows `cover()` over its own cover so the image crossfades with the swipe. */
@Component({
  selector: 'app-swipe-track',
  imports: [NgTemplateOutlet, SwipeSkipDirective],
  templateUrl: './swipe-track.html',
  host: { class: 'relative block min-w-0 flex-1 overflow-hidden' },
})
export class SwipeTrackComponent {
  readonly output = input.required<AudioOutput>();
  /** The host's title lines, given the neighbour a swipe brings in, or null for the current track: both look alike. */
  readonly lines = input.required<TemplateRef<{ $implicit: MusicTrackRequest | null }>>();
  readonly disabled = input(false);
  readonly skipped = output<'next' | 'previous'>();

  /** Drag offset as a fraction of the title width; negative towards the next track. */
  private readonly dx = signal(0);
  private readonly phase = signal<Phase>('idle');
  private readonly target = signal<MusicTrackRequest | null>(null);
  private readonly holding = signal(false);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly allow = computed(() => {
    const o = this.output();
    const many = !this.disabled() && o.queue().length > 1;
    return { next: many && !!o.neighbour(1), previous: many && !!o.neighbour(-1) };
  });

  /** 1 when the next track is coming in from the right, -1 for the previous one from the left. */
  private readonly side = signal<1 | -1>(1);
  protected readonly settling = computed(() => this.phase() === 'back' || this.phase() === 'skip');
  protected readonly peek = computed(() => (this.phase() === 'idle' ? null : this.target()));

  /** The title is gone at 40% of the width, the neighbour shows from 50% to 80%. */
  protected readonly currentStyle = computed(() => {
    const out = this.side() === 1 ? '-' : '';
    switch (this.phase()) {
      case 'drag':
        return { transform: `translateX(${this.dx() * 100}%)`, opacity: Math.max(0, 1 - Math.abs(this.dx()) / 0.4) };
      case 'skip':
        return { transform: `translateX(calc(${out}100% ${out || '+'} ${GAP}))`, opacity: 0 };
      default:
        return { transform: '', opacity: 1 };
    }
  });

  protected readonly peekStyle = computed(() => {
    const offset = this.side() === 1 ? `100% + ${GAP}` : `-100% - ${GAP}`;
    switch (this.phase()) {
      case 'drag':
        return { transform: `translateX(calc(${this.dx() * 100}% + ${offset}))`, opacity: this.fadeIn() };
      case 'skip':
        return { transform: 'translateX(0)', opacity: 1 };
      default:
        return { transform: `translateX(calc(${offset}))`, opacity: 0 };
    }
  });

  /** The neighbour's cover and how much of it shows over the host's cover. */
  readonly cover = computed(() => {
    const url = this.target()?.coverUrl;
    if (!url) return null;
    const phase = this.phase();
    if (phase === 'idle') return this.holding() ? { url, opacity: 1, settle: false } : null;
    return { url, opacity: phase === 'drag' ? this.fadeIn() : phase === 'skip' ? 1 : 0, settle: phase !== 'drag' };
  });

  private fadeIn(): number {
    return Math.min(1, Math.max(0, (Math.abs(this.dx()) - 0.5) / 0.3));
  }

  protected onDragged(dx: number): void {
    if (this.phase() !== 'drag') this.finish();
    clearTimeout(this.holdTimer);
    this.holding.set(false);
    this.phase.set('drag');
    this.dx.set(dx);
    if (dx) this.side.set(dx < 0 ? 1 : -1);
    this.target.set(dx ? this.output().neighbour(dx < 0 ? 1 : -1) : null);
  }

  protected onReleased(dir: 'next' | 'previous' | null): void {
    this.phase.set(dir && this.target() ? 'skip' : 'back');
    this.timer = setTimeout(() => this.finish(), SETTLE_MS);
  }

  /** Ends a settle at once: a skip is sent, and the neighbour's cover holds while the host's own fades in. */
  private finish(): void {
    clearTimeout(this.timer);
    const skip = this.phase() === 'skip';
    this.phase.set('idle');
    this.dx.set(0);
    if (!skip) return this.target.set(null);
    this.skipped.emit(this.side() === 1 ? 'next' : 'previous');
    this.holding.set(true);
    clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => {
      this.holding.set(false);
      this.target.set(null);
    }, COVER_HOLD_MS);
  }
}
