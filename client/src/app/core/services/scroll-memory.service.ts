import { Injectable, Injector, afterNextRender, inject } from '@angular/core';
import { NavigationEnd, NavigationStart, Router, Scroll } from '@angular/router';

@Injectable({ providedIn: 'root' })
export class ScrollMemoryService {
  private positions = new Map<string, number>();
  private currentKey: string | null = null;
  private readonly router = inject(Router);
  /** False between NavigationStart and the router's own scroll. */
  private routerScrolled = true;
  private queued: (() => void)[] = [];
  private stickFrame: number | null = null;

  constructor() {
    // Angular sets this itself for every mode but `disabled`, and the router is
    // on `disabled` precisely so it keeps its hands off the scroll. Without it
    // the browser restores its own offsets on popstate, on top of ours.
    if (typeof history !== 'undefined') history.scrollRestoration = 'manual';

    this.router.events.subscribe((event) => {
      // Save scroll position BEFORE navigation starts (scroll is still intact)
      if (event instanceof NavigationStart) {
        if (this.currentKey) this.positions.set(this.currentKey, window.scrollY);
        this.routerScrolled = false;
        // A restore still in flight belongs to the page being left. Left alone
        // it keeps calling scrollTo for the rest of its window, on a document
        // that is now the next page — which lands wherever the outgoing offset
        // clamps to, and fights the router's scroll-to-top all the way there.
        this.cancelStick();
        this.queued = [];
      }
      // Every navigation lands at the top from here: in the same frame as the
      // DOM swap, and a return then has its offset put back by `restoreSticky`
      // later in that same frame. The router used to do this a frame after
      // NavigationEnd, which fell in the middle of the poster morph.
      //
      // NavigationStart is too early — the view transition captures the
      // outgoing page after it, and scrolling the list away first left the
      // morphing poster with no card to grow out of.
      //
      // `nav-back` is NavbarService's verdict on the navigation in flight,
      // published on <html> at NavigationStart, so it is set by the time this
      // runs whichever order the two services subscribed in. Read from the
      // class rather than injected: this service is constructed early enough
      // that importing NavbarService reorders module init, and `app.config`
      // resolves the device at module scope.
      if (event instanceof NavigationEnd) {
        this.toTop(!document.documentElement.classList.contains('nav-back'));
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
    if (this.routerScrolled) this.stick(key, target);
    else this.queued.push(() => this.stick(key, target));
  }

  private stick(key: string, target: number): void {
    this.cancelStick();
    const deadline = performance.now() + 600;
    const tick = () => {
      this.stickFrame = null;
      // The page this restore was for is no longer the one on screen.
      if (this.currentKey !== key) return;
      if (Math.abs(window.scrollY - target) < 1) return;
      window.scrollTo({ top: target, left: 0, behavior: 'instant' });
      if (performance.now() < deadline) this.stickFrame = requestAnimationFrame(tick);
    };
    tick();
  }

  /**
   * Take the incoming page to the top. `hold` keeps it there for a moment: one
   * scrollTo is not enough on an opening, because WebKit drops it while
   * WKWebView is still settling the scroll view's contentSize and then keeps
   * adjusting the offset for a few frames as the page's height lands. The hold
   * ends on the first touch so it never fights a user who scrolls straight
   * away, and a return does not take one at all — its offset is restored right
   * after this.
   */
  private toTop(hold: boolean): void {
    if (typeof window === 'undefined') return;
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    if (!hold) return;
    const deadline = performance.now() + 400;
    let released = false;
    const release = () => {
      released = true;
      window.removeEventListener('touchstart', release);
    };
    window.addEventListener('touchstart', release, { passive: true, once: true });
    const tick = () => {
      this.stickFrame = null;
      if (released) return;
      if (window.scrollY !== 0) window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      if (performance.now() < deadline) this.stickFrame = requestAnimationFrame(tick);
      else release();
    };
    this.stickFrame = requestAnimationFrame(tick);
  }

  private cancelStick(): void {
    if (this.stickFrame !== null) {
      cancelAnimationFrame(this.stickFrame);
      this.stickFrame = null;
    }
  }
}
