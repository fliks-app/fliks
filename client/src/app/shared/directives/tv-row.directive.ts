import { Directive, ElementRef, HostListener, inject, OnDestroy, OnInit, input } from '@angular/core';
import { TvSpatialNavService } from '../../core/services/tv-spatial-nav.service';
import { TvService } from '../../core/services/tv.service';

/**
 * Horizontal-orientation container in the spatial-nav tree. `←/→` step
 * between siblings, `↑/↓` exit the row and propagate to the parent
 * section. Last-active card is remembered for horizontal `←/→` moves;
 * `↑/↓` into the row from another row lands on the first card.
 *
 * Apply on horizontal scrollers / card lanes:
 *
 *   <div appTvRow class="flex overflow-x-auto"> ... </div>
 *
 * Registers on every form factor — desktop keyboard users get the same
 * tree-aware nav as TV D-pad. `[appTvRowWrap]="true"` enables → from the
 * last card looping back to the first (handy on circular content like
 * cast lists).
 */
@Directive({
  selector: '[appTvRow]',
  standalone: true,
})
export class TvRowDirective implements OnInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly nav = inject(TvSpatialNavService);
  private readonly tv = inject(TvService);

  readonly appTvRowWrap = input(false);
  /** Smooth-scroll the page so the row sits 24 px below the viewport top
   *  when focus enters from outside. Used on standalone rows (e.g. the
   *  top-right cast/user dock) that aren't wrapped in
   *  `<app-horizontal-scroller>`, which has the same behaviour built-in. */
  readonly appTvRowSnap = input(false);

  ngOnInit(): void {
    this.nav.registerContainer(this.host.nativeElement, {
      orientation: 'horizontal',
      isWrapping: this.appTvRowWrap(),
    });
  }

  ngOnDestroy(): void {
    this.nav.unregisterContainer(this.host.nativeElement);
  }

  @HostListener('focusin', ['$event'])
  protected onFocusIn(event: FocusEvent): void {
    if (!this.appTvRowSnap()) return;
    const from = event.relatedTarget as Node | null;
    if (from && this.host.nativeElement.contains(from)) return;
    queueMicrotask(() => this.snapToRowTop());
  }

  private snapToRowTop(): void {
    if (typeof window === 'undefined') return;
    const scrollEl = document.scrollingElement ?? document.documentElement;
    const rect = this.host.nativeElement.getBoundingClientRect();
    const currentTop = scrollEl.scrollTop ?? 0;
    const TOP_OFFSET = this.tv.isTv() ? 96 : 24;
    // Skip when the row is already fully visible: the user is just walking
    // between visible rows, no scroll needed.
    const viewportH = window.innerHeight;
    if (rect.top >= TOP_OFFSET && rect.bottom <= viewportH) return;
    const targetTop = Math.max(0, currentTop + rect.top - TOP_OFFSET);
    if (Math.abs(targetTop - currentTop) < 4) return;
    try {
      window.scrollTo({ top: targetTop, left: 0, behavior: 'smooth' });
    } catch {
      window.scrollTo(0, targetTop);
    }
  }
}
