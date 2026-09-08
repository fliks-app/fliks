import { Component, DestroyRef, computed, inject, input, linkedSignal } from '@angular/core';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { ImgFadeInDirective } from '../directives/img-fade-in.directive';

/**
 * Mobile-only hero image (series fanart, episode still, etc.) — extends under the transparent navbar
 * via global `.hero-fanart-bleed` on `body.hero-page`. Parent should wrap in `lg:hidden` when desktop differs.
 */
@Component({
  selector: 'app-mobile-fanart-hero',
  imports: [ResolveUrlPipe, ImgFadeInDirective],
  templateUrl: './mobile-fanart-hero.html',
})
export class MobileFanartHeroComponent {
  readonly fanartUrl = input<string | null | undefined>(null);
  readonly imageAlt = input('');
  /** Pairs this hero with the card that opened the page, so the poster morph
   *  has a destination on mobile too — the box carries the whole aspect change,
   *  portrait card into landscape hero. On the wrapper rather than the image so
   *  the scrim the title sits on travels with it. Null where nothing pairs. */
  readonly viewTransitionName = input<string | null>(null);

  protected readonly incoming = computed(() => {
    const url = this.fanartUrl();
    return url ? [url] : [];
  });

  /** The url this hero was showing before the current one. */
  protected readonly outgoing = linkedSignal<string | null | undefined, string | null>({
    source: () => this.fanartUrl(),
    computation: (next, previous) => (previous?.source && next ? previous.source : null),
  });

  private timer?: ReturnType<typeof setTimeout>;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  /** Drop the old layer once the fade has covered it: its mask leaves the
   *  bottom translucent, so keeping it would ghost through. */
  protected onIncomingLoad() {
    if (!this.outgoing()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.outgoing.set(null), 250);
  }
}
