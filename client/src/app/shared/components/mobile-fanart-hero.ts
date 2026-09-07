import { Component, input } from '@angular/core';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { ImgFadeInDirective } from '../directives/img-fade-in.directive';

/**
 * Mobile-only hero image (series fanart, episode still, etc.) — extends under the transparent navbar
 * via global `.hero-fanart-bleed` on `body.hero-page`. Parent should wrap in `lg:hidden` when desktop differs.
 */
@Component({
  selector: 'app-mobile-fanart-hero',
  imports: [ResolveUrlPipe, ImgFadeInDirective],
  template: `
    <div class="relative -mx-4 -mt-4 hero-fanart-bleed">
      @if (fanartUrl()) {
        <!-- The name rides the image, not the wrapper: desktop pairs img with
             img and its morph shows the destination's picture, a div snapshot
             does not. -->
        <img
          appImgFadeIn
          [style.view-transition-name]="viewTransitionName()"
          [src]="fanartUrl()! | resolveUrl:'medium'"
          [alt]="imageAlt()"
          loading="eager"
          fetchpriority="high"
          class="hero-fanart-fade relative w-full min-h-[230px] h-[38svh] max-h-[53svh] landscape:min-h-0 landscape:h-auto landscape:max-h-[47vh] landscape:aspect-video object-cover object-[50%_25%]"
        />

      } @else {
        <div
          class="w-full min-h-[230px] h-[38svh] max-h-[53svh] landscape:min-h-0 landscape:h-auto landscape:aspect-video landscape:max-h-[47vh] bg-base-300"
        ></div>
      }
    </div>
  `,
})
export class MobileFanartHeroComponent {
  readonly fanartUrl = input<string | null | undefined>(null);
  readonly imageAlt = input('');
  /** Pairs this hero with the card that opened the page, so the poster morph
   *  has a destination on mobile too — the box carries the whole aspect change,
   *  portrait card into landscape hero. On the wrapper rather than the image so
   *  the scrim the title sits on travels with it. Null where nothing pairs. */
  readonly viewTransitionName = input<string | null>(null);
}
