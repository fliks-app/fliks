import { Directive, ElementRef, HostListener, inject, OnDestroy, OnInit, input } from '@angular/core';
import { TvSpatialNavService } from '../../core/services/tv-spatial-nav.service';
import { TvService } from '../../core/services/tv.service';
import { rowTopOffset, snapRowOnFocus } from '../../core/utils/focus-snap.util';

/** Horizontal container in the spatial-nav tree: `←/→` step siblings (last-active card remembered), `↑/↓` exit the row and land on the first card.
 *  Registers on every form factor; `[appTvRowWrap]="true"` loops → from the last card back to the first. */
@Directive({
  selector: '[appTvRow]',
  standalone: true,
})
export class TvRowDirective implements OnInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly nav = inject(TvSpatialNavService);
  private readonly tv = inject(TvService);

  readonly appTvRowWrap = input(false);
  /** Smooth-scroll so the row sits 24 px below the viewport top on entry; for standalone rows outside `<app-horizontal-scroller>`, which does this itself. */
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
