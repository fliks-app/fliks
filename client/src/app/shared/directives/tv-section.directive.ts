import { Directive, ElementRef, inject, OnDestroy, OnInit, input } from '@angular/core';
import { TvSpatialNavService } from '../../core/services/tv-spatial-nav.service';

/** Marks a region as a vertical spatial-nav container: `↑/↓` step between its direct navigable children, `←/→` walk inside sub-containers.
 *  Registers on every form factor; companion to `[appTvRow]`. `[appTvSectionWrap]="true"` wraps ↑ from the first child to the last (rare). */
@Directive({
  selector: '[appTvSection]',
  standalone: true,
})
export class TvSectionDirective implements OnInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly nav = inject(TvSpatialNavService);

  readonly appTvSectionWrap = input(false);

  ngOnInit(): void {
    this.nav.registerContainer(this.host.nativeElement, {
      orientation: 'vertical',
      isWrapping: this.appTvSectionWrap(),
    });
  }

  ngOnDestroy(): void {
    this.nav.unregisterContainer(this.host.nativeElement);
  }
}
