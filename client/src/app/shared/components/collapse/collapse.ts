import { Component, OnDestroy, effect, input, signal, untracked } from '@angular/core';

/** Slightly past the fold transition, so the clip outlives the motion. */
const UNCLIP_DELAY_MS = 250;

/** Body that folds to zero height and back, animated; the header that drives `open` is the caller's. */
@Component({
  selector: 'app-collapse',
  templateUrl: './collapse.html',
  host: { class: 'block' },
})
export class CollapseComponent implements OnDestroy {
  readonly open = input.required<boolean>();

  /** Clipped only while folding: open, a card rail must bleed out its focus ring and a menu must not be cut. */
  protected readonly clipped = signal(true);
  private unclipTimer: ReturnType<typeof setTimeout> | null = null;
  private first = true;

  private readonly sync = effect(() => {
    const open = this.open();
    untracked(() => {
      if (this.unclipTimer) clearTimeout(this.unclipTimer);
      if (!open) {
        this.clipped.set(true);
      } else if (this.first) {
        this.clipped.set(false);
      } else {
        // Timer, not `transitionend`: Tizen snaps open without firing it.
        this.unclipTimer = setTimeout(() => this.clipped.set(false), UNCLIP_DELAY_MS);
      }
      this.first = false;
    });
  });

  ngOnDestroy() {
    if (this.unclipTimer) clearTimeout(this.unclipTimer);
  }
}
