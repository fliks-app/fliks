import { Injectable, Injector, afterNextRender, inject } from '@angular/core';
import { NavigationEnd, NavigationSkipped, NavigationStart, Router, Scroll } from '@angular/router';
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
  /** Bumped per navigation, so a deferred hold never acts on the page after it. */
  private navigation = 0;
  private queued: (() => void)[] = [];
  private settledUrl = '';
  /** The navigation only changed the query on the same path: a page's tabs, filters or month, which keep the offset. */
  private inPage = false;

  constructor() {
    // The router scrolls nothing (`scrollPositionRestoration: 'disabled'`): every navigation's offset is decided here.
    history.scrollRestoration = 'manual';
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        const [path, query = ''] = event.urlAfterRedirects.split('#')[0].split('?');
        const [prevPath, prevQuery = ''] = this.settledUrl.split('#')[0].split('?');
        this.inPage = path === prevPath && query !== prevQuery;
        this.settledUrl = event.urlAfterRedirects;
      }
      if (event instanceof NavigationSkipped) this.inPage = false;
      // Save scroll position BEFORE navigation starts (scroll is still intact)
      if (event instanceof NavigationStart) {
        this.navigation++;
        if (this.currentKey) this.positions.set(this.currentKey, this.pageScroller.offset());
        this.routerScrolled = false;
      }
      if (event instanceof Scroll) {
        this.routerScrolled = true;
        const due = this.queued;
        this.queued = [];
        // A microtask, so nothing in between paints.
        if (due.length) queueMicrotask(() => due.forEach((fn) => fn()));
        // A call may say otherwise: `scroll: 'after-transition'` resets an in-page change, `'manual'` keeps any.
        const keep = event.scrollBehavior ? event.scrollBehavior === 'manual' : this.inPage;
        if (keep) return;
        // A return with a queued restore goes straight to it; one without starts at the top until its page restores.
        if (!this.navbar.navigatedBack()) queueMicrotask(() => this.enterAtTop());
        else if (!due.length && this.pageScroller.offset() > 0) this.pageScroller.scrollTo(0);
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

  /** Guard against a detached component stomping on the next page's activate() when both fire in close succession. */
  deactivateIf(key: string) {
    if (this.currentKey === key) this.currentKey = null;
  }

  restore(key: string, injector: Injector) {
    const y = this.positions.get(key);
    if (!y) return;
    afterNextRender(() => this.pageScroller.scrollTo(y), { injector });
  }

  /** For route reattach (cached DOM laid out): applies after the router's turn, then re-applies about 600 ms via rAF for a growing document, stopping once scrollY equals the target. */
  restoreSticky(key: string): void {
    const target = this.positions.get(key);
    if (!target) return;
    // A cached route reattaches before the router scrolls; restoring now would scroll the outgoing page and jump three times.
    if (this.routerScrolled) this.stick(target);
    else this.queued.push(() => this.stick(target));
  }

  /** Holds a forward entry at the top: a WKWebView still sizing the document drops the router's single scroll, and the taller page's offset clamps to the footer.
   * Two passes (sticky, plus a listener for a later off-thread clamp), ending on a zero read and on the first user gesture respectively. */
  private enterAtTop(): void {
    // Read on the next frame, still before a view transition captures: a read now forced a layout the rest of the render redid.
    const navigation = this.navigation;
    requestAnimationFrame(() => navigation === this.navigation && this.stick(0));

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
