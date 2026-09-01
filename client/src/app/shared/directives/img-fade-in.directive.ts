import { Directive, ElementRef, inject, OnInit } from '@angular/core';
import { viewTransitionRunning } from '../utils/view-transition';

/**
 * Hides the image until it finishes downloading, then fades it in. Avoids
 * the browser's default top-down progressive paint that looks janky on
 * fanart / poster hero images. Cached responses (already complete on
 * mount) skip the transition and show immediately, and so does an image
 * mounted during a view transition: the morph is already the animation.
 *
 * Usage: <img appImgFadeIn [src]="..." />
 */
@Directive({
  selector: 'img[appImgFadeIn]',
  standalone: true,
  host: {
    '[style.opacity]': 'opacity',
    '[style.transition]': '"opacity 200ms ease-out"',
    '(load)': 'onLoad()',
  },
})
export class ImgFadeInDirective implements OnInit {
  private readonly host = inject<ElementRef<HTMLImageElement>>(ElementRef);
  protected opacity = '0';

  ngOnInit() {
    const img = this.host.nativeElement;
    if (viewTransitionRunning() || (img.complete && img.naturalWidth > 0)) {
      this.opacity = '1';
    }
  }

  protected onLoad() {
    this.opacity = '1';
  }
}
