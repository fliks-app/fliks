import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { NavigationCancel, NavigationError, NavigationStart, Router } from '@angular/router';
import { DeviceService } from '../../../core/services/device.service';
import { BackgroundService } from '../../../core/services/background.service';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../directives/cached-src.directive';

/** Page-wide background, mounted above the route outlet (the player is a top-level route and would take a layout-level one with it).
 *  Crossfade ring of three layers: the next url fades in over the opaque outgoing image once decoded; only a fade to nothing dims a layer. */
const LAYERS = 3;

interface Layer {
  url: string | null;
  blur: boolean;
}

@Component({
  selector: 'app-background',
  imports: [CachedSrcDirective, ResolveUrlPipe],
  templateUrl: './background.html',
})
export class BackgroundComponent {
  protected readonly bg = inject(BackgroundService);
  private readonly router = inject(Router);
  /** 0 at the top of the page, 1 once scrolled two fifths of the viewport. */
  private readonly scroll = signal(0);
  /** How much of the hero look is applied, 0 to 1. It rises over the length of the image crossfade, so the light veil only reveals the picture as it fades in, and drops at once: a navigation resets the scroll to the top, which would draw the hero look for the frames a falling tween takes. */
  private readonly mix = signal(0);
  private readonly veiled = computed(() => this.mix() > 0);
  /** `claims` when the navigation started: the leaving page's hero claim outlives the route change by a few frames and must not bring the hero look back. */
  private readonly heldAt = signal(-1);
  private variant: 'full' | 'compact' = 'full';
  private tween = 0;

  /** The veil of a hero claim as one background, its alphas interpolated from the hero look to the ambient one; null for the ambient CSS veil. */
  protected readonly heroVeil = computed(() => {
    const m = this.mix();
    if (m === 0) return null;
    const p = 1 - m * (1 - this.scroll());
    const [from, to] = this.variant === 'compact' ? [12, 45] : [35, 72];
    const rgba = (a: number) => `rgba(29, 35, 42, ${a.toFixed(3)})`;
    // The vertical layer reaches the ambient alpha by half way, so the stacked layers never let more picture through than either end.
    const q = Math.min(1, 2 * p);
    const side = (a: number) => rgba(a * (1 - p));
    return (
      `linear-gradient(to bottom, ${rgba(0.95 * q)} ${from}%, ${rgba(0.95)} ${to}%), ` +
      `linear-gradient(to right, ${side(0.92)} 0%, ${side(0.8)} 40%, ${side(0.35)} 65%, ${side(0.08)} 90%, ${side(0)} 100%)`
    );
  });

  /** Reduced effects swap images without the crossfade and draw the cover fallback unblurred. */
  readonly reduced = inject(DeviceService).reducedEffects();
  private readonly fade = this.reduced ? '' : ' transition-opacity duration-1500';
  readonly layers = signal<readonly Layer[]>(Array<Layer>(LAYERS).fill({ url: null, blur: false }));
  /** Layer fading in on top; `null` while the backdrop fades out to nothing. */
  readonly active = signal<number | null>(null);
  /** Layer held opaque under the fade: the image the viewer is leaving. */
  readonly previous = signal<number | null>(null);
  /** Layer whose image is still loading; promoted once it has decoded. */
  private pending: number | null = null;

  constructor() {
    effect((onCleanup) => {
      const hero = this.bg.hero();
      if (hero) this.variant = hero;
      const target = hero && this.bg.claims() !== this.heldAt() ? 1 : 0;
      const from = untracked(() => this.mix());
      if (from === target) return;
      if (target === 0) {
        this.mix.set(0);
        return;
      }
      const start = performance.now();
      const step = (now: number) => {
        const t = this.reduced ? 1 : Math.min(1, (now - start) / 1500);
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
    const sub = this.router.events.subscribe((e) => {
      if (e instanceof NavigationStart) {
        this.heldAt.set(untracked(() => this.bg.claims()));
      } else if (e instanceof NavigationCancel || e instanceof NavigationError) {
        // The page stays: its claim is still the current one.
        this.heldAt.set(-1);
      }
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
    let last: Layer = { url: null, blur: false };
    effect(() => {
      const next = { url: this.bg.url(), blur: this.bg.blur() };
      if (next.url === last.url && next.blur === last.blur) return;
      last = next;
      this.pending = null;
      if (next.url === null) {
        this.show(null);
        return;
      }
      const target = this.freeLayer();
      // The same image already sits there, so no load event will come.
      const held = this.layers()[target];
      if (held.url === next.url && held.blur === next.blur) {
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
    if (index === active) return 'opacity-100 z-20' + this.fade;
    if (index !== this.previous()) return 'opacity-0';
    return active === null ? 'opacity-0' + this.fade : 'opacity-100 z-10';
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
