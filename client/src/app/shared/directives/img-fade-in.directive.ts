import { Directive, ElementRef, inject, input, OnInit } from '@angular/core';
import { viewTransitionRunning } from '../utils/view-transition';

/** Hides the image until downloaded, then fades in, avoiding the janky progressive paint; cached images and images mounted during a view transition show immediately. */
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

  /** Show the picture at once: the caller runs its own transition over it. */
  readonly instant = input(false);

  ngOnInit() {
    const img = this.host.nativeElement;
    if (this.instant() || viewTransitionRunning() || (img.complete && img.naturalWidth > 0)) {
      this.opacity = '1';
    }
  }

  protected onLoad() {
    this.opacity = '1';
  }
}
