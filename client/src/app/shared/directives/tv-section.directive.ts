import { Directive, ElementRef, inject, OnDestroy, OnInit, input } from '@angular/core';
import { TvService } from '../../core/services/tv.service';
import { TvSpatialNavService } from '../../core/services/tv-spatial-nav.service';

/**
 * Marks a region as a vertical-orientation container in the TV spatial-nav
 * tree. `↑/↓` step between this section's direct navigable children
 * (registered sub-containers + focusable leaves), `←/→` walk inside its
 * sub-containers as defined by their own orientation.
 *
 * Pages opt in by wrapping their main scroll surface:
 *
 *   <main appTvSection> ... </main>
 *
 * No-op outside TV (the directive registers nothing). Companion to
 * `[appTvRow]` for horizontal regions.
 *
 * Set `[appTvSectionWrap]="true"` to make ↑ from the first child wrap to
 * the last (rare; typically left off so the user doesn't loop the whole
 * page accidentally).
 */
@Directive({
  selector: '[appTvSection]',
  standalone: true,
})
export class TvSectionDirective implements OnInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly tv = inject(TvService);
  private readonly nav = inject(TvSpatialNavService);

  readonly appTvSectionWrap = input(false);

  ngOnInit(): void {
    if (!this.tv.isTv()) return;
    this.nav.registerContainer(this.host.nativeElement, {
      orientation: 'vertical',
      isWrapping: this.appTvSectionWrap(),
    });
  }

  ngOnDestroy(): void {
    if (!this.tv.isTv()) return;
    this.nav.unregisterContainer(this.host.nativeElement);
  }
}
