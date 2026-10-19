import { Directive, ElementRef, OnDestroy, computed, effect, inject, input, signal } from '@angular/core';

/** Drives a show-more / show-less toggle for a `line-clamp-*` paragraph by measuring overflow (CSS can't report a clamp), re-measured on resize
 *  since a `md:hidden` ancestor measures zero. Usage: `<p appClampToggle #syn="clampToggle" ...>`; bind the text (`[appClampToggle]="text"`) if it changes in place. */
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
