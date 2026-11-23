import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { DeviceService } from '../../../core/services/device.service';
import { BackgroundService } from '../../../core/services/background.service';
import { NavbarService } from '../../../core/services/navbar.service';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../directives/cached-src.directive';
import { backdropFollowsTransition } from '../../utils/view-transition';

/** Page-wide background, mounted above the route outlet (the player is a top-level route and would take a layout-level one with it).
 *  Crossfade ring of three layers: the next url fades in over the opaque outgoing image once decoded; only a fade to nothing dims a layer. */
const LAYERS = 3;
/** The ambient veil's alpha (`--bg-veil`), which the hero veil turns into as the page scrolls. */
const AMBIENT = 0.95;

interface Layer {
  url: string | null;
  blur: boolean;
  /** A hero is seen through a light veil at full width: it needs the full-size variant. */
  hero: boolean;
}

@Component({
  selector: 'app-background',
  imports: [CachedSrcDirective, ResolveUrlPipe],
  templateUrl: './background.html',
})
export class BackgroundComponent {
  protected readonly bg = inject(BackgroundService);
  private readonly railWidth = inject(NavbarService).railWidth;
  /** 0 at the top of the page, 1 once scrolled two fifths of the viewport. */
  private readonly scroll = signal(0);
  /** How much of the hero look is applied, 0 to 1. It rises over the length of the image crossfade, so the light veil only reveals the picture as it fades in, and drops at once: a navigation resets the scroll to the top, which would draw the hero look for the frames a falling tween takes. */
  private readonly mix = signal(0);
  private readonly veiled = computed(() => this.mix() > 0);
  private tween = 0;

  /** The veil of a hero claim as one background, its alphas interpolated from the hero look to the ambient one; null for the ambient CSS veil. */
  protected readonly heroVeil = computed(() => {
    const m = this.mix();
    if (m === 0) return null;
    const p = 1 - m * (1 - this.scroll());
    const rgba = (a: number) => `rgba(29, 35, 42, ${a.toFixed(3)})`;
    const v = AMBIENT * Math.min(1, 2 * p);
    // Each side stop is solved so the stacked layers let through a linear mix of the hero and ambient amounts: a scroll never brightens then darkens.
    const side = (a: number) => rgba(Math.min(1, Math.max(0, 1 - ((1 - p) * (1 - a) + (1 - AMBIENT) * p) / (1 - v))));
    // (1 - t³)² reaches the rim with a zero slope: linear stops draw the ellipse's outline as a visible line.
    const fade = [0, 0.2, 0.4, 0.55, 0.7, 0.8, 0.9, 1].map((t) => `${side((1 - t ** 3) ** 2)} ${Math.round(t * 100)}%`).join(', ');
    return (
      `linear-gradient(to bottom, ${rgba(v)} 25%, ${rgba(AMBIENT)} 60%), ` +
      // From the rail's edge (the backdrop runs under it), centred on the text block.
      `radial-gradient(ellipse 62% 85% at ${this.railWidth()} 60%, ${fade})`
    );
  });

  /** Reduced effects swap images without the crossfade and draw the cover fallback unblurred. */
  readonly reduced = inject(DeviceService).reducedEffects();
  /** The running transition's page fade carries the backdrop change: it must be final when the new page is captured, not fade a second time after. */
  private readonly instant = signal(false);
  readonly layers = signal<readonly Layer[]>(Array<Layer>(LAYERS).fill({ url: null, blur: false, hero: false }));
  /** Layer fading in on top; `null` while the backdrop fades out to nothing. */
  readonly active = signal<number | null>(null);
  /** Layer held opaque under the fade: the image the viewer is leaving. */
  readonly previous = signal<number | null>(null);
  /** Layer whose image is still loading; promoted once it has decoded. */
  private pending: number | null = null;

  constructor() {
    effect((onCleanup) => {
      const hero = this.bg.hero();
      const target = hero ? 1 : 0;
      const from = untracked(() => this.mix());
      if (from === target) return;
      // With no picture on screen yet (a reload), the veil has nothing to reveal early: it takes its shape at once and the picture fades in under it.
      if (target === 0 || this.reduced || backdropFollowsTransition() || untracked(() => this.active()) === null) {
        this.mix.set(target);
        return;
      }
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / 1500);
        this.mix.set(from + (target - from) * t);
        if (t < 1) this.tween = requestAnimationFrame(step);
      };
      this.tween = requestAnimationFrame(step);
      onCleanup(() => cancelAnimationFrame(this.tween));
    });
    effect((onCleanup) => {
      if (!this.veiled()) return;
      const read = () => this.scroll.set(Math.min(1, Math.max(0, window.scrollY / (window.innerHeight * 0.4))));
      read();
      window.addEventListener('scroll', read, { passive: true });
      onCleanup(() => window.removeEventListener('scroll', read));
    });
    let last: Layer = { url: null, blur: false, hero: false };
    effect(() => {
      const next = { url: this.bg.url(), blur: this.bg.blur(), hero: this.bg.hero() };
      if (next.url === last.url && next.blur === last.blur && next.hero === last.hero) return;
      last = next;
      this.pending = null;
      this.instant.set(backdropFollowsTransition());
      if (next.url === null) {
        this.show(null);
        return;
      }
      const same = (l: Layer) => l.url === next.url && l.blur === next.blur && l.hero === next.hero;
      // A layer already holding the image gets no load event; under a transition any layer will do, else only a free one fades over the rest.
      const held = this.instant() ? this.layers().findIndex(same) : -1;
      const target = held >= 0 ? held : this.freeLayer();
      if (same(this.layers()[target])) {
        this.show(target);
        return;
      }
      this.pending = target;
      this.layers.update((ls) => ls.map((l, i) => (i === target ? next : l)));
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
    const fade = this.reduced || this.instant() ? '' : ' transition-opacity duration-1500';
    if (index === active) return 'opacity-100 z-20' + fade;
    if (index !== this.previous()) return 'opacity-0';
    return active === null ? 'opacity-0' + fade : 'opacity-100 z-10';
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
