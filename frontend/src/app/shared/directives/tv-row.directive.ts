import { Directive, ElementRef, inject, OnDestroy, OnInit, input } from '@angular/core';
import { TvService } from '../../core/services/tv.service';
import { TvSpatialNavService } from '../../core/services/tv-spatial-nav.service';

/**
 * Horizontal-orientation container in the TV spatial-nav tree. `←/→` step
 * between siblings, `↑/↓` exit the row and propagate to the parent
 * section. Last-active card is remembered, so re-entering the row from
 * above/below lands back on it instead of the first card.
 *
 * Apply on horizontal scrollers / card lanes:
 *
 *   <div appTvRow class="flex overflow-x-auto"> ... </div>
 *
 * No-op outside TV. `[appTvRowWrap]="true"` enables → from the last card
 * looping back to the first (handy on circular content like cast lists).
 */
@Directive({
  selector: '[appTvRow]',
  standalone: true,
})
export class TvRowDirective implements OnInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly tv = inject(TvService);
  private readonly nav = inject(TvSpatialNavService);

  readonly appTvRowWrap = input(false);

  ngOnInit(): void {
    if (!this.tv.isTv()) return;
    this.nav.registerContainer(this.host.nativeElement, {
      orientation: 'horizontal',
      isWrapping: this.appTvRowWrap(),
    });
  }

  ngOnDestroy(): void {
    if (!this.tv.isTv()) return;
    this.nav.unregisterContainer(this.host.nativeElement);
  }
}
