import { Location } from '@angular/common';
import { Injectable, TemplateRef, computed, inject, signal } from '@angular/core';
import { NavigationEnd, NavigationStart, Router, Scroll } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { DeviceService } from './device.service';
import { isRootEntryRoute } from '../../shared/utils/view-transition';

export type RailMode = 'none' | 'drawer' | 'collapsed' | 'expanded';

/** Lets child pages communicate with the navbar (e.g. hero pages setting a title). */
@Injectable({ providedIn: 'root' })
export class NavbarService {
  /** When set, the navbar shows this title instead of "Fliks" on scroll. */
  readonly heroTitle = signal('');
  /** Clearlogo for the current hero page, shown in the topbar / back row in
   *  place of the title text. Null when the page has no logo. */
  readonly heroLogoUrl = signal<string | null>(null);
  /** Opens the page's actions menu from the mobile navbar, in place of the user menu; null when the page has none. */
  readonly heroMenu = signal<((anchor: HTMLElement) => void) | null>(null);
  /** Now-playing bars the rail renders in its footer in place of the bottom of the screen, which the D-pad reaches last. */
  readonly dockedBars = signal<readonly TemplateRef<unknown>[]>([]);
  /** Whether the current page has a hero fanart. */
  readonly isHeroPage = signal(false);
  /** Non-hero pages can opt into the layout's desktop back button by setting
   *  this, without taking on the hero styling. */
  readonly showBackButton = signal(false);
  /** The bar's centre text, hero page or not (set from route data or by the page), with an optional icon. */
  readonly pageTitle = signal('');
  readonly pageIcon = signal<{ name: string; color?: string } | null>(null);
  private readonly titles = new Map<string, { title: string; icon: { name: string; color?: string } | null }>();
  /** Whether the window is scrolled near the top (updated by LayoutComponent). */
  /** True when at least one in-app navigation has happened since entering — used to gate back buttons. */
  readonly canGoBack = signal(false);

  /** How the left rail shows: `none` (phone dock), `drawer` (hamburger, below md and on phones without the dock),
   *  `collapsed` (icons; TV, md to lg) or `expanded` (lg+). */
  readonly railMode = computed<RailMode>(() => {
    if (this.phoneDock()) return 'none';
    if (this.device.isTv()) return 'collapsed';
    if (this.device.isPhone() || !this.isMediumScreen()) return 'drawer';
    if (!this.isLargeScreen()) return 'collapsed';
    return 'expanded';
  });

  /** The rail is a permanent column (collapsed or expanded) rather than a drawer or absent. */
  readonly railDocked = computed(() => this.railMode() === 'collapsed' || this.railMode() === 'expanded');

  /** The docked rail's column width, as a CSS length; 0 when the rail is a drawer or absent. */
  readonly railWidth = computed(() => {
    const mode = this.railMode();
    return mode === 'collapsed' ? 'var(--rail-w)' : mode === 'expanded' ? '16rem' : '0px';
  });

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
  /** True while the viewport matches Tailwind's `md` breakpoint (≥768px). */
  private readonly isMediumScreen = signal(false);
  /** True while the viewport matches Tailwind's `lg` breakpoint (≥1024px). */
  private readonly isLargeScreen = signal(false);
  private readonly isLandscape = signal(false);


  constructor() {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(min-width: 1024px)');
      this.isLargeScreen.set(mq.matches);
      mq.addEventListener('change', (e) => this.isLargeScreen.set(e.matches));
      const md = window.matchMedia('(min-width: 768px)');
      this.isMediumScreen.set(md.matches);
      md.addEventListener('change', (e) => this.isMediumScreen.set(e.matches));
      const landscape = window.matchMedia('(orientation: landscape)');
      this.isLandscape.set(landscape.matches);
      landscape.addEventListener('change', (e) => this.isLandscape.set(e.matches));
    }
    // Empty, not `router.url`: seeding before the initial navigation would push a phantom '/' entry.
    let lastUrl = '';
    let lastWasEntry = false;
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
      // A new page names itself while it activates; one restored from the route cache gets back the name it had.
      if (e instanceof NavigationStart && this.pathOf(e.url) !== this.pathOf(this.router.url)) {
        this.titles.set(this.pathOf(this.router.url), { title: this.pageTitle(), icon: this.pageIcon() });
        const kept = this.titles.get(this.pathOf(e.url));
        this.setPageTitle(kept?.title ?? '', kept?.icon ?? null);
      }
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
        const entryRoute = isRootEntryRoute(this.router.routerState.snapshot.root);
        const rootEntry = entryRoute || !!(this.location.getState() as { rootEntry?: boolean } | null)?.rootEntry;
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
          // A player is never a back target, whichever way it was left; nor is an entry screen once signed in.
          !lastUrl.startsWith('/watch') &&
          !lastWasEntry &&
          this.pathOf(lastUrl) !== this.pathOf(e.urlAfterRedirects)
        ) {
          // Only a path change pushes a back entry; query-only changes (tabs, filters, sort) are in-page state.
          this.history.push(lastUrl);
        }
        lastUrl = e.urlAfterRedirects;
        lastWasEntry = entryRoute;
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

  /** True when the top mobile navbar is rendered: wherever the rail is not a permanent column. */
  readonly mobileNavbarVisible = computed(() => !this.railDocked());

  /** Top padding that clears the mobile navbar for a desktop-layout hero; null when no navbar overlaps it. */
  readonly heroPaddingTop = computed(() =>
    this.isHeroPage() && !this.device.isTv() && this.mobileNavbarVisible()
      ? 'calc(env(safe-area-inset-top, 0px) + 3rem)'
      : null,
  );

  /** The page's name: a hero's title, else the page title. */
  readonly mobileNavTitle = computed(() => (this.isHeroPage() && this.heroTitle()) || this.pageTitle());

  /** The hero page's picture still reaches below the phone bar. */
  readonly heroUnderBar = signal(true);
  /** The phone bar has no background while the hero picture is under it. */
  readonly navbarTransparent = computed(
    () => this.mobileNavbarVisible() && this.isHeroPage() && this.heroUnderBar(),
  );

  /** The page that holds the hero chrome: only it can hand it back, so a leaving page never clears its successor's claim. */
  private heroOwner: object | null = null;
  /** The hero's centre is the brand logo (home), not a title's clearlogo. */
  readonly heroBrand = signal(false);

  private heroHost: Element | null = null;
  private heroWatch: { io?: IntersectionObserver; mo?: MutationObserver } = {};

  /** Claim the hero chrome for `owner` (transparent navbar, white icons); the centre shows the hero's logo or brand, else the page title.
   *  `host` is the page element holding its `[data-hero-picture]`: the bar stays clear while that picture is under it. */
  enterHeroPage(owner: object, centre: { title?: string; logoUrl?: string | null; brand?: boolean; host?: Element } = {}) {
    this.heroOwner = owner;
    if (centre.host !== this.heroHost) this.watchHero(centre.host ?? null);
    document.body.classList.add('hero-page');
    this.isHeroPage.set(true);
    this.heroTitle.set(centre.title ?? '');
    this.heroLogoUrl.set(centre.logoUrl ?? null);
    this.heroBrand.set(!!centre.brand);
  }

  leaveHeroPage(owner: object) {
    if (this.heroOwner !== owner) return;
    this.heroOwner = null;
    this.watchHero(null);
    document.body.classList.remove('hero-page');
    this.isHeroPage.set(false);
    this.heroTitle.set('');
    this.heroLogoUrl.set(null);
    this.heroBrand.set(false);
    this.heroMenu.set(null);
  }

  /** One observer on the claimed page's picture, offset by the bar's height; it waits for the picture when the page draws it late. */
  private watchHero(host: Element | null): void {
    this.heroWatch.io?.disconnect();
    this.heroWatch.mo?.disconnect();
    this.heroWatch = {};
    this.heroHost = host;
    this.heroUnderBar.set(true);
    if (!host || typeof IntersectionObserver === 'undefined') return;
    const observe = (picture: Element) => {
      const bar = document.querySelector<HTMLElement>('nav.navbar')?.offsetHeight ?? 0;
      const io = new IntersectionObserver(([e]) => {
        // The page drew a new picture (another episode): follow that one.
        if (!e.target.isConnected) return this.watchHero(host);
        this.heroUnderBar.set(e.isIntersecting);
      }, { rootMargin: `-${bar}px 0px 0px 0px` });
      io.observe(picture);
      this.heroWatch.io = io;
    };
    const found = host.querySelector('[data-hero-picture]');
    if (found) return observe(found);
    const mo = new MutationObserver(() => {
      const picture = host.querySelector('[data-hero-picture]');
      if (!picture) return;
      mo.disconnect();
      observe(picture);
    });
    mo.observe(host, { childList: true, subtree: true });
    this.heroWatch.mo = mo;
  }

  setPageTitle(title: string, icon: { name: string; color?: string } | null = null) {
    this.pageTitle.set(title);
    this.pageIcon.set(icon);
  }

}
