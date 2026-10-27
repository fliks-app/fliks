import { Directive, ElementRef, inject, OnDestroy, OnInit } from '@angular/core';
import { TvSpatialNavService } from '../../core/services/tv-spatial-nav.service';

/** A 2-D region in the spatial-nav tree (an emoji or card grid): arrows move by geometry inside it, its edge leaves to the enclosing container. */
@Directive({
  selector: '[appTvGrid]',
  standalone: true,
})
export class TvGridDirective implements OnInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly nav = inject(TvSpatialNavService);

  ngOnInit(): void {
    this.nav.registerContainer(this.host.nativeElement, { orientation: 'grid' });
  }

  ngOnDestroy(): void {
    this.nav.unregisterContainer(this.host.nativeElement);
  }
}
