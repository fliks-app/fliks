import { ChangeDetectionStrategy, Component, input } from '@angular/core';
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
        <img
          appImgFadeIn
          [src]="fanartUrl()! | resolveUrl:'medium'"
          [alt]="imageAlt()"
          loading="eager"
          fetchpriority="high"
          class="w-full min-h-[230px] h-[38svh] max-h-[53svh] landscape:min-h-0 landscape:h-auto landscape:max-h-[47vh] landscape:aspect-video object-cover object-[50%_25%]"
        />
        <div class="pointer-events-none absolute inset-0 bg-linear-to-t from-base-100 via-transparent to-black/20"></div>
      } @else {
        <div
          class="w-full min-h-[230px] h-[38svh] max-h-[53svh] landscape:min-h-0 landscape:h-auto landscape:aspect-video landscape:max-h-[47vh] bg-base-300"
        ></div>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MobileFanartHeroComponent {
  readonly fanartUrl = input<string | null | undefined>(null);
  readonly imageAlt = input('');
}
