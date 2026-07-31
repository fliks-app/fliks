import { Directive, ElementRef, OnDestroy, computed, effect, inject, input, signal } from '@angular/core';

/**
 * Drives a show-more / show-less toggle for a `line-clamp-*` paragraph. CSS
 * can't report that a clamp took effect, so the overflow is measured — and
 * re-measured on every resize, since a paragraph hidden by a responsive
 * `md:hidden` wrapper measures as zero-height until its layout is visible.
 *
 * Usage:
 *   <p appClampToggle #syn="clampToggle" [class.line-clamp-4]="!syn.expanded()">{{ text }}</p>
 *   @if (syn.showToggle()) { <button (click)="syn.toggle()">…</button> }
 *
 * Bind the text (`[appClampToggle]="text"`) when it can change in place, so
 * the paragraph collapses and re-measures instead of keeping a stale verdict.
 */
@Directive({
  selector: '[appClampToggle]',
  standalone: true,
  exportAs: 'clampToggle',
})
export class ClampToggleDirective implements OnDestroy {
  readonly text = input<unknown>(undefined, { alias: 'appClampToggle' });

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly observer = new ResizeObserver(() => this.measure());

  readonly clamped = signal(false);
  readonly expanded = signal(false);
  /** Expanded text no longer overflows, but it still needs its collapse button. */
  readonly showToggle = computed(() => this.clamped() || this.expanded());

  constructor() {
    this.observer.observe(this.host.nativeElement);
    effect((onCleanup) => {
      this.text();
      this.expanded.set(false);
      const frame = requestAnimationFrame(() => this.measure());
      onCleanup(() => cancelAnimationFrame(frame));
    });
  }

  toggle() {
    this.expanded.update((v) => !v);
  }

  ngOnDestroy() {
    this.observer.disconnect();
  }

  private measure() {
    const el = this.host.nativeElement;
    this.clamped.set(el.scrollHeight > el.clientHeight + 1);
  }
}
