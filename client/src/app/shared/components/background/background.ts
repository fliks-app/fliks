import { Component, effect, inject, signal } from '@angular/core';
import { BackgroundService } from '../../../core/services/background.service';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../directives/cached-src.directive';

/**
 * Page-wide background renderer. Mounted at the app root, above the outlet
 * every route swaps through, so the image covers everything — including under
 * the sidebar. It has to sit above the outlet rather than in the layout: the
 * player is a top-level route and would take the layout, and this, with it.
 *
 * Crossfade: a ring of three layers. The next url is written into the layer
 * nobody can see, brought up only once its image has decoded (an <img> keeps
 * painting its old image until then), and fades in over the outgoing image,
 * which stays fully opaque underneath so the fade goes image to image and
 * never dips through the base colour. Only a fade to nothing dims a layer.
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
  /** Layer fading in on top; `null` while the backdrop fades out to nothing. */
  readonly active = signal<number | null>(null);
  /** Layer held opaque under the fade: the image the viewer is leaving. */
  readonly previous = signal<number | null>(null);
  /** Layer whose image is still loading; promoted once it has decoded. */
  private pending: number | null = null;

  constructor() {
    let last: string | null = null;
    effect(() => {
      const next = this.bg.url();
      if (next === last) return;
      last = next;
      this.pending = null;
      if (next === null) {
        this.show(null);
        return;
      }
      const target = this.freeLayer();
      // The same image already sits there, so no load event will come.
      if (this.layers()[target] === next) {
        this.show(target);
        return;
      }
      this.pending = target;
      this.layers.update((ls) => ls.map((url, i) => (i === target ? next : url)));
    });
  }

  onLoad(index: number, event: Event): void {
    if (index !== this.pending) return;
    const img = event.target as HTMLImageElement;
    const src = img.currentSrc;
    void img
      .decode()
      .catch(() => undefined)
      .then(() => {
        if (index !== this.pending || img.currentSrc !== src) return;
        this.pending = null;
        this.show(index);
      });
  }

  layerClass(index: number): string {
    const active = this.active();
    if (index === active) return 'opacity-100 z-20 transition-opacity duration-1500';
    if (index !== this.previous()) return 'opacity-0';
    return active === null ? 'opacity-0 transition-opacity duration-1500' : 'opacity-100 z-10';
  }

  private show(index: number | null): void {
    if (index === this.active()) return;
    this.previous.set(this.active());
    this.active.set(index);
  }

  private freeLayer(): number {
    const busy = [this.active(), this.previous()];
    return this.layers().findIndex((_, i) => !busy.includes(i));
  }
}
