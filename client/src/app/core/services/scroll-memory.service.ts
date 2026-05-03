import { Injectable, Injector, afterNextRender, inject } from '@angular/core';
import { Router, NavigationStart } from '@angular/router';

@Injectable({ providedIn: 'root' })
export class ScrollMemoryService {
  private positions = new Map<string, number>();
  private currentKey: string | null = null;
  private readonly router = inject(Router);

  constructor() {
    // Save scroll position BEFORE navigation starts (scroll is still intact)
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart && this.currentKey) {
        this.positions.set(this.currentKey, window.scrollY);
      }
    });
  }

  /** Call on component init to register which key to track. */
  activate(key: string) {
    this.currentKey = key;
  }

  /** Call on component destroy to stop tracking. */
  deactivate() {
    this.currentKey = null;
  }

  /**
   * Stop tracking only if the active key still matches `key`. Useful when a
   * component is detached (route reuse) before another page has had a chance
   * to claim the active key — without this guard we'd stomp on the next
   * page's activate() call when both fire in close succession.
   */
  deactivateIf(key: string) {
    if (this.currentKey === key) this.currentKey = null;
  }

  /**
   * Restore scroll position after Angular has rendered.
   */
  restore(key: string, injector: Injector) {
    const y = this.positions.get(key);
    if (!y) return;
    afterNextRender(() => {
      window.scrollTo(0, y);
    }, { injector });
  }

  /**
   * Restore scroll past every concurrent scroll-fighter (Router's
   * `withInMemoryScrolling` scroll-to-top, view transitions, browser native
   * restore). Re-applies for ~600 ms with rAF gating: stops on the first
   * frame where scrollY already equals the target — so a user scroll within
   * the window stops the loop cleanly too. Use this on route reattach where
   * the cached DOM is already laid out.
   *
   * `behavior: 'instant'` is mandatory: TV builds set `scroll-behavior: smooth`
   * on `html.tv-host` for D-pad navigation, which would otherwise turn each
   * frame's `scrollTo` into a competing smooth animation and stall the loop.
   */
  restoreSticky(key: string): void {
    const target = this.positions.get(key);
    if (!target) return;
    const deadline = performance.now() + 600;
    const tick = () => {
      if (Math.abs(window.scrollY - target) < 1) return;
      window.scrollTo({ top: target, left: 0, behavior: 'instant' });
      if (performance.now() < deadline) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
