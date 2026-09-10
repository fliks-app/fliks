import { Injectable, Injector, afterNextRender, inject } from '@angular/core';
import { NavigationStart, Router, Scroll } from '@angular/router';
import { NavbarService } from './navbar.service';
import { PageScrollerService } from './page-scroller.service';

/** How long a forward entry defends its own top. Long enough to outlast the
 *  incoming document's growth, short enough to be over before a reader is. */
const TOP_HOLD_MS = 600;
/** Anything of these means the offset is the user's business now. */
const USER_INPUT = ['touchstart', 'wheel', 'keydown'] as const;

@Injectable({ providedIn: 'root' })
export class ScrollMemoryService {
  private positions = new Map<string, number>();
  private currentKey: string | null = null;
  private readonly router = inject(Router);
  private readonly pageScroller = inject(PageScrollerService);
  /** Only a return asks for a remembered offset; everything else opens at the
   *  top, and {@link enterAtTop} is what makes that stick. */
  private readonly navbar = inject(NavbarService);
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
        if (!this.navbar.navigatedBack()) queueMicrotask(() => this.enterAtTop());
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

  /**
   * Hold a forward entry at the top. The router scrolls there once, and a
   * WKWebView still sizing the incoming document drops that write — leaving
   * the page at the offset the taller page before it had, which the new
   * document's own maximum clamps to its footer.
   *
   * Two passes, because that clamp is not bound to this task: the sticky one
   * for an offset that is already wrong, and a listener for the one that
   * arrives a few frames later off the scrolling thread. Both end early —
   * the first on the frame it reads zero, the second on the first thing the
   * user does, so neither ever pulls against a real gesture.
   */
  private enterAtTop(): void {
    this.stick(0);

    const deadline = performance.now() + TOP_HOLD_MS;
    const done = () => {
      window.removeEventListener('scroll', onScroll);
      for (const ev of USER_INPUT) window.removeEventListener(ev, done);
    };
    const onScroll = () => {
      if (performance.now() > deadline) return done();
      if (this.pageScroller.offset() > 1) this.pageScroller.scrollTo(0);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    for (const ev of USER_INPUT) window.addEventListener(ev, done, { passive: true, once: true });
  }

  private stick(target: number): void {
    const deadline = performance.now() + 600;
    const tick = () => {
      if (Math.abs(this.pageScroller.offset() - target) < 1) return;
      this.pageScroller.scrollTo(target);
      if (performance.now() < deadline) requestAnimationFrame(tick);
    };
    tick();
  }
}
