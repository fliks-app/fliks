import { Injectable, Injector, afterNextRender, inject } from '@angular/core';
import { NavigationStart, Router, Scroll } from '@angular/router';

@Injectable({ providedIn: 'root' })
export class ScrollMemoryService {
  private positions = new Map<string, number>();
  private currentKey: string | null = null;
  private readonly router = inject(Router);
  /** False between NavigationStart and the router's own scroll. */
  private routerScrolled = true;
  private queued: (() => void)[] = [];

  constructor() {
    this.router.events.subscribe((event) => {
      // Save scroll position BEFORE navigation starts (scroll is still intact)
      if (event instanceof NavigationStart) {
        if (this.currentKey) this.positions.set(this.currentKey, window.scrollY);
        this.routerScrolled = false;
      }
      if (event instanceof Scroll) {
        this.routerScrolled = true;
        const due = this.queued;
        this.queued = [];
        // A microtask, so this lands after the router's own subscriber has
        // scrolled whatever subscriber order puts first — same task either
        // way, so nothing in between is ever painted.
        if (due.length) queueMicrotask(() => due.forEach((fn) => fn()));
      }
    });
  }

  /** The offset held for `key`, for a page that has to lay itself out for the
   *  offset it is about to be restored to rather than the one it has. */
  remembered(key: string): number | undefined {
    return this.positions.get(key);
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
      window.scrollTo({ top: y, left: 0, behavior: 'instant' });
    }, { injector });
  }

  /**
   * Restore scroll on route reattach, where the cached DOM is already laid out.
   * Applies once the router has taken its turn, then re-applies for ~600 ms
   * with rAF gating for a document that is still growing — stopping on the
   * first frame where scrollY already equals the target, so a user scroll
   * within the window ends the loop cleanly too.
   *
   * `behavior: 'instant'` is mandatory: TV builds set `scroll-behavior: smooth`
   * on `html.tv-host` for D-pad navigation, which would otherwise turn each
   * frame's `scrollTo` into a competing smooth animation and stall the loop.
   */
  restoreSticky(key: string): void {
    const target = this.positions.get(key);
    if (!target) return;
    // A cached route is reattached before the router scrolls, so restoring now
    // would scroll the page being left, be overwritten by the scroll-to-top,
    // and then correct itself — three jumps, the first of them on the outgoing
    // page. Wait for the router to have had its turn.
    if (this.routerScrolled) this.stick(target);
    else this.queued.push(() => this.stick(target));
  }

  private stick(target: number): void {
    const deadline = performance.now() + 600;
    const tick = () => {
      if (Math.abs(window.scrollY - target) < 1) return;
      window.scrollTo({ top: target, left: 0, behavior: 'instant' });
      if (performance.now() < deadline) requestAnimationFrame(tick);
    };
    tick();
  }
}
