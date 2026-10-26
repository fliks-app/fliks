import { Location } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';
import { NavigationEnd, NavigationStart, Router, Scroll } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { DeviceService } from './device.service';

/** Lets child pages communicate with the navbar (e.g. hero pages setting a title). */
@Injectable({ providedIn: 'root' })
export class NavbarService {
  /** When set, the navbar shows this title instead of "Fliks" on scroll. */
  readonly heroTitle = signal('');
  /** Clearlogo for the current hero page, shown in the topbar / back row in
   *  place of the title text. Null when the page has no logo. */
  readonly heroLogoUrl = signal<string | null>(null);
  /** Whether the current page has a hero fanart. */
  readonly isHeroPage = signal(false);
  /** Non-hero pages can opt into the layout's desktop back button by setting
   *  this, without taking on the hero styling. */
  readonly showBackButton = signal(false);
  /** Resolved title for non-hero routes (set from route data or by components). */
  readonly pageTitle = signal('');
  /** Whether the window is scrolled near the top (updated by LayoutComponent). */
  readonly scrollAtTop = signal(true);
  /** True when at least one in-app navigation has happened since entering — used to gate back buttons. */
  readonly canGoBack = signal(false);
  /** Whether the sidebar stays pinned at lg on form factors that default to a drawer (tablet); persisted, on by default. Desktop always pins, phones never. */
  readonly sidebarPinned = signal(
    localStorage.getItem('fliks.sidebarPinned') !== 'false',
  );
  /** Effective pin state: off on narrow screens and always off on TV (10-foot surface); the stored preference is kept. */
  readonly effectiveSidebarPinned = computed(
    () => this.sidebarPinned() && this.isLargeScreen() && !this.device.isTv(),
  );

  /** Whether the layout shows the sidebar as a permanent column; keeps the form-factor list in one place. */
  readonly sidebarDocked = computed(
    () => this.device.isDesktop() || this.effectiveSidebarPinned(),
  );

  /** Native phone bottom dock; landscape is too short for it, so the topbar hamburger takes over there. */
  readonly phoneDock = computed(
    () => this.isNativePlatform && this.device.isPhone() && !this.isLandscape(),
  );

  private readonly device = inject(DeviceService);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  /** Stack of in-app URLs we've visited (most recent last, current excluded). */
  private readonly history: string[] = [];
  /** Set while goBack() navigates, so its NavigationEnd counts as a "pop" and doesn't re-push the URL we leave. */
  private isPoppingBack = false;
  /** Claims the very next NavigationStart as this goBack()'s own, closed there
   *  so a push starting in the same window isn't misread as a return too. */
  private backNavPending = false;
  /** Capacitor native platform — exposed so templates can branch on it. */
  readonly isNativePlatform = Capacitor.isNativePlatform();
  private get isNative() { return this.isNativePlatform; }
  /** True while the viewport matches Tailwind's `lg` breakpoint (≥1024px). */
  private readonly isLargeScreen = signal(false);
  private readonly isLandscape = signal(false);


  constructor() {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(min-width: 1024px)');
      this.isLargeScreen.set(mq.matches);
      mq.addEventListener('change', (e) => this.isLargeScreen.set(e.matches));
      const landscape = window.matchMedia('(orientation: landscape)');
      this.isLandscape.set(landscape.matches);
      landscape.addEventListener('change', (e) => this.isLandscape.set(e.matches));
    }
    // Empty, not `router.url`: seeding before the initial navigation would push a phantom '/' entry.
    let lastUrl = '';
    this.router.events.subscribe((e) => {
      if (e instanceof NavigationStart) {
        // A returned-to page must look as left; not `isPoppingBack` (top-level nav sets it too). backNavPending, not lastWasBack:
        // it must not survive into a push that starts before lastWasBack's .then() reset.
        const back = e.navigationTrigger === 'popstate' || this.backNavPending;
        this.backNavPending = false;
        this.navigatedBack.set(back);
        document.documentElement.classList.toggle('nav-back', back);
        // The router restores the offset with the two-argument `scrollTo`,
        // which honours `scroll-behavior`; TV would animate the jump to top.
        document.documentElement.classList.add('nav-scroll-instant');
      }
      if (e instanceof Scroll) {
        document.documentElement.classList.remove('nav-scroll-instant');
      }
      // Browser back/forward: mirror the pop on our stack so goBack() doesn't walk forward into the page just left.
      if (e instanceof NavigationStart && e.navigationTrigger === 'popstate') {
        // Only a popstate landing on the top of our stack is a back-pop; a stray one (Android IME history entry) would swallow the next push.
        if (this.history[this.history.length - 1] === e.url) {
          this.isPoppingBack = true;
          this.history.pop();
        }
      }
      if (e instanceof NavigationEnd) {
        // Top-level entries mark their own navigation, so the stack is decided
        // by where the router landed rather than by a click that preceded it.
        const rootEntry = !!(this.location.getState() as { rootEntry?: boolean } | null)?.rootEntry;
        const popped = this.isPoppingBack;
        this.isPoppingBack = false;
        // goBack() navigates to a URL recorded here rather than calling
        // history.back(): Capacitor's WebView drops SPA pushState entries.
        if (rootEntry) {
          this.history.length = 0;
        } else if (popped) {
          // Nothing to push: this navigation IS the pop.
        } else if (
          lastUrl &&
          // A player is never a back target, whichever way it was left.
          !lastUrl.startsWith('/watch') &&
          this.pathOf(lastUrl) !== this.pathOf(e.urlAfterRedirects)
        ) {
          // Only a path change pushes a back entry; query-only changes (tabs, filters, sort) are in-page state.
          this.history.push(lastUrl);
        }
        lastUrl = e.urlAfterRedirects;
        // Our stack is empty after a hard refresh: fall back to browser history. Skipped on native, where the WebView doesn't track it (see goBack()).
        const hasRealHistory = !this.isNative && window.history.length > 1;
        this.canGoBack.set(
          !rootEntry && (this.history.length > 0 || hasRealHistory) && this.router.url !== '/',
        );
      }
    });
  }

  /** Depth of the back stack; the iOS swipe-back reads it to keep its page-snapshot stack aligned. */
  get backDepth(): number {
    return this.history.length;
  }

  /** URL path without query/fragment — query-only changes on the same path are
   *  in-page state (tabs / filters), not navigations to push onto the stack. */
  private pathOf(url: string): string {
    return url.split(/[?#]/)[0];
  }


  /** Mark the next navigation as "going back" so its NavigationEnd doesn't push the URL we leave; for callers navigating via Router directly. */
  markAsBackNavigation() {
    this.isPoppingBack = true;
  }

  /** Navigate back in history when possible, else to `fallback` (or home if none given). */
  /** Set when goBack() is currently navigating; consumed by the destination
   *  page's ngOnInit to decide between restoring focus vs. landing default. */
  readonly lastWasBack = signal(false);

  /** Whether the navigation in flight is a return, held until the next one; wider than {@link lastWasBack} (browser and gesture back skip goBack()). */
  readonly navigatedBack = signal(false);

  /** Reset a macrotask later so the destination's ngOnInit still sees `true`; runs on rejection too. */
  private resetLastWasBack(): void {
    // backNavPending is normally already closed by its own NavigationStart;
    // cleared here too as a backstop if that navigation never started one.
    setTimeout(() => {
      this.lastWasBack.set(false);
      this.backNavPending = false;
    }, 0);
  }

  goBack(fallback?: readonly (string | number)[]): void {
    const prev = this.history.pop();
    if (prev) {
      this.isPoppingBack = true;
      this.lastWasBack.set(true);
      this.backNavPending = true;
      void this.router
        .navigateByUrl(prev)
        .then(() => this.resetLastWasBack(), () => this.resetLastWasBack());
      return;
    }
    if (!this.isNative && window.history.length > 1) {
      this.isPoppingBack = true;
      this.lastWasBack.set(true);
      this.backNavPending = true;
      const sub = this.router.events.subscribe((e) => {
        if (e instanceof NavigationEnd) {
          sub.unsubscribe();
          this.resetLastWasBack();
        }
      });
      window.history.back();
      return;
    }
    if (fallback?.length) {
      this.router.navigate([...fallback]);
    } else {
      this.router.navigate(['/']);
    }
  }

  /** True when the top mobile navbar is rendered; hidden on tablet when the sidebar is pinned, so back-button pages must mirror that. */
  readonly mobileNavbarVisible = computed(() => {
    // Mirror the layout's navbar visibility: hidden at lg+ on desktop, and on tablet only when the sidebar is pinned.
    if (this.isLargeScreen() && this.device.isDesktop()) return false;
    // One test now that the pin itself rules out a TV: naming the form factors
    // twice let the two drift apart.
    return !this.effectiveSidebarPinned();
  });

  /** Mobile navbar center: hero title on fanart pages, otherwise static/dynamic page title. */
  readonly mobileNavTitle = computed(() =>
    this.isHeroPage() ? this.heroTitle() : this.pageTitle(),
  );

  /** True while the transparent hero-page navbar is shown (visible + hero page + scrolled at top). */
  readonly navbarTransparent = computed(
    () => this.mobileNavbarVisible() && this.scrollAtTop() && this.isHeroPage(),
  );

  /** Mark the current page as having a hero fanart (enables transparent navbar + white icons). */
  enterHeroPage(title: string, logoUrl: string | null = null) {
    document.body.classList.add('hero-page');
    this.isHeroPage.set(true);
    this.pageTitle.set('');
    this.heroTitle.set(title);
    this.heroLogoUrl.set(logoUrl);
  }

  leaveHeroPage() {
    document.body.classList.remove('hero-page');
    this.isHeroPage.set(false);
    this.heroTitle.set('');
    this.heroLogoUrl.set(null);
  }

  toggleSidebarPinned() {
    const next = !this.sidebarPinned();
    this.sidebarPinned.set(next);
    localStorage.setItem('fliks.sidebarPinned', String(next));
  }

  /** Sets the in-layout page title (ignored while on a hero page). */
  setPageTitle(title: string) {
    if (this.isHeroPage()) return;
    this.pageTitle.set(title);
  }

  clearPageTitle() {
    this.pageTitle.set('');
  }
}
