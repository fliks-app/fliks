import { Injectable, Injector, afterNextRender, inject } from '@angular/core';
import { NavigationStart, Router, Scroll } from '@angular/router';
import { PageScrollerService } from './page-scroller.service';

@Injectable({ providedIn: 'root' })
export class ScrollMemoryService {
  private positions = new Map<string, number>();
  private currentKey: string | null = null;
  private readonly router = inject(Router);
  /** Whatever scrolls the active page — the document, or a container a page
   *  claimed. Both scroll models therefore share this one save/restore path. */
  private readonly pageScroller = inject(PageScrollerService);
  /** False between NavigationStart and the router's own scroll. */
  private routerScrolled = true;
  private queued: (() => void)[] = [];

  constructor() {
    this.router.events.subscribe((event) => {
      // Save scroll position BEFORE navigation starts (scroll is still intact)
      if (event instanceof NavigationStart) {
        if (this.currentKey) this.positions.set(this.currentKey, this.pageScroller.offset());
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
    afterNextRender(() => this.pageScroller.scrollTo(y), { injector });
  }

  /**
   * Restore scroll on route reattach, where the cached DOM is already laid out.
   * Applies once the router has taken its turn, then re-applies for ~600 ms
   * with rAF gating for a document that is still growing — stopping on the
   * first frame where scrollY already equals the target, so a user scroll
   * within the window ends the loop cleanly too.
   *
   * The retry window also covers a container scroller reattached before its
   * content is laid out, where the first write clamps to 0.
   */
  restoreSticky(key: string): void {
    const target = this.positions.get(key);
    if (!target) return;
    // A cached route is reattached before the router scrolls, so restoring now
    // would scroll the page being left, be overwritten by the scroll-to-top,
    // and then correct itself — three jumps, the first of them on the outgoing
    // page. Wait for the router to have had its turn.
    // Captured now, not when the loop starts: the caller has just claimed the
    // scroller it wants written, and by the router's turn another page may have.
    const owner = this.pageScroller.element();
    if (this.routerScrolled) this.stick(target, owner);
    else this.queued.push(() => this.stick(target, owner));
  }

  private stick(target: number, owner: HTMLElement | null): void {
    const deadline = performance.now() + 600;
    const tick = () => {
      // Another page's claim means we are no longer the page being restored;
      // writing on would scroll the one navigated to.
      if (this.pageScroller.element() !== owner) return;
      if (Math.abs(this.pageScroller.offset() - target) < 1) return;
      this.pageScroller.scrollTo(target);
      if (performance.now() < deadline) requestAnimationFrame(tick);
    };
    tick();
  }
}
