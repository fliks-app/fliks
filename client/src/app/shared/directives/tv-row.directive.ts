import { Directive, ElementRef, HostListener, inject, OnDestroy, OnInit, input } from '@angular/core';
import { TvSpatialNavService } from '../../core/services/tv-spatial-nav.service';
import { TvService } from '../../core/services/tv.service';
import { rowTopOffset, snapRowOnFocus } from '../../core/utils/focus-snap.util';

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
    snapRowOnFocus(event, this.host.nativeElement, rowTopOffset(this.tv.isTv()));
  }
}
