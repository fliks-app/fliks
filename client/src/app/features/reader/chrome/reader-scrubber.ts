import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { ReaderSession } from '../reader-session';

/** The progress bar: a transparent native range over a drawn track, one segment per section, with a preview bubble. */
@Component({
  selector: 'app-reader-scrubber',
  imports: [TranslatePipe],
  templateUrl: './reader-scrubber.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
})
export class ReaderScrubberComponent {
  protected readonly s = inject(ReaderSession);
  private readonly engine = this.s.engine;
  protected readonly rtl = computed(() => !!this.engine()?.rtl());
  /** The last stop of the range: one per page of a paged format. */
  protected readonly max = computed(() => Math.max(0, (this.engine()?.steps() ?? 1) - 1));
  /** The mouse position over the bar, previewed like a drag. */
  private readonly hovering = signal<number | null>(null);

  protected readonly bubble = computed(() => {
    const at = this.s.scrubbing() ?? this.hovering();
    const engine = this.engine();
    if (at == null || !engine) return null;
    return { at, ...engine.preview(at), pages: engine.status().pages, percent: Math.round(at * 100) };
  });

  protected readonly segments = computed(() => {
    const starts = this.engine()?.segments() ?? [0];
    const bounds = [...starts, 1];
    const at = this.s.shownProgression();
    return starts.map((start, i) => {
      const end = bounds[i + 1];
      return { start, width: end - start, fill: Math.min(1, Math.max(0, (at - start) / (end - start))) };
    });
  });

  private valueOf(e: Event): number {
    const max = this.max();
    return max ? Number((e.target as HTMLInputElement).value) / max : 0;
  }

  protected onHover(e: PointerEvent): void {
    if (e.pointerType !== 'mouse') return;
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    this.hovering.set(this.rtl() ? 1 - x : x);
  }

  protected onLeave(): void {
    this.hovering.set(null);
  }

  protected onScrub(e: Event): void {
    this.s.scrubbing.set(this.valueOf(e));
  }

  protected onSeek(e: Event): void {
    this.s.seek(this.valueOf(e));
  }
}
