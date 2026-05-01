import { Directive, ElementRef, inject, OnInit } from '@angular/core';

/**
 * Hides the image until it finishes downloading, then fades it in. Avoids
 * the browser's default top-down progressive paint that looks janky on
 * fanart / poster hero images. Cached responses (already complete on
 * mount) skip the transition and show immediately.
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
    if (this.host.nativeElement.complete && this.host.nativeElement.naturalWidth > 0) {
      this.opacity = '1';
    }
  }

  protected onLoad() {
    this.opacity = '1';
  }
}
