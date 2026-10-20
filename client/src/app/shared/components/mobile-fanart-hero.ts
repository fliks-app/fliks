import { Component, computed, effect, input, linkedSignal, untracked } from '@angular/core';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { ImgFadeInDirective } from '../directives/img-fade-in.directive';
import {
  viewTransitionAnimating,
  viewTransitionDone,
  viewTransitionRunning,
} from '../utils/view-transition';

/** Mobile-only hero extending under the transparent navbar via `.hero-fanart-bleed` on `body.hero-page`; the parent wraps it in `lg:hidden` when desktop differs. */
@Component({
  selector: 'app-mobile-fanart-hero',
  imports: [ResolveUrlPipe, ImgFadeInDirective],
  templateUrl: './mobile-fanart-hero.html',
})
export class MobileFanartHeroComponent {
  readonly fanartUrl = input<string | null | undefined>(null);
  readonly imageAlt = input('');
  /** Pairs the hero with the opening card for the poster morph; on the wrapper so the title scrim travels with it. Null where nothing pairs. */
  readonly viewTransitionName = input<string | null>(null);

  /** The url on screen, held while a morph animates: re-keying the image drops the
   *  element the transition captured, and the browser skips the whole morph. */
  private readonly shown = linkedSignal<string | null | undefined, string | null | undefined>({
    source: () => this.fanartUrl(),
    computation: (next, previous) =>
      previous && viewTransitionAnimating() ? previous.value : next,
  });

  private readonly releaseHeld = effect(() => {
    if (this.fanartUrl() === untracked(this.shown)) return;
    void viewTransitionDone().then(() => this.shown.set(this.fanartUrl()));
  });

  protected readonly incoming = computed(() => {
    const url = this.shown();
    return url ? [url] : [];
  });

  /** The previous url, except during a transition: the page is frozen to snapshots, so the fade would play unseen over the departing episode. */
  protected readonly outgoing = linkedSignal<string | null | undefined, string | null>({
    source: () => this.shown(),
    computation: (next, previous) =>
      previous?.source && next && !viewTransitionRunning() ? previous.source : null,
  });

  /** Reset by its source, so a swap landing mid-fade starts its own. */
  protected readonly fadingOut = linkedSignal<string | null | undefined, boolean>({
    source: () => this.shown(),
    computation: () => false,
  });

  /** Nothing is faded out before the picture underneath can be seen. */
  protected onIncomingLoad() {
    if (this.outgoing()) this.fadingOut.set(true);
  }
}
