import {
  Component,
  effect,
  inject,
  signal,
} from '@angular/core';
import { BackgroundService } from '../../../core/services/background.service';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../directives/cached-src.directive';

/**
 * Page-wide background renderer. Mounted at the app root, above the outlet
 * every route swaps through, so the image covers everything — including under
 * the sidebar — and survives a trip to the player, which is a top-level route
 * and would otherwise take the whole layout, and this, down with it.
 *
 * Crossfade strategy: a ring of layers, one visible at a time. A new url is
 * written into the next one, which then fades in over the others. Two would be
 * enough only if every fade finished before the next url arrived; browsing
 * between pages is faster than that, and reusing a layer still on screen swaps
 * its image in place. A third gives the writer a layer that has been hidden for
 * two turns, so the image it replaces is never one the viewer can see.
 */
const LAYERS = 3;

@Component({
  selector: 'app-background',
  imports: [CachedSrcDirective, ResolveUrlPipe],
  templateUrl: './background.html',
})
export class BackgroundComponent {
  private readonly bg = inject(BackgroundService);

  readonly layers = signal<readonly (string | null)[]>(Array<string | null>(LAYERS).fill(null));
  readonly activeLayer = signal(0);
  /** Tracks whether the active layer should currently be at full
   *  opacity. The image is dimmed in CSS (filter: brightness),
   *  so we no longer need a separate veil — fade-out can use the
   *  image opacity directly without showing un-tinted colour. */
  readonly imageVisible = signal(false);

  constructor() {
    let last: string | null = null;
    effect(() => {
      const next = this.bg.url();
      if (next === last) return;
      last = next;

      if (next === null) {
        this.imageVisible.set(false);
        return;
      }

      this.imageVisible.set(true);
      const target = (this.activeLayer() + 1) % LAYERS;
      this.layers.update((ls) => ls.map((url, i) => (i === target ? next : url)));
      this.activeLayer.set(target);
    });
  }
}
