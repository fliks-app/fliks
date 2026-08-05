import { Injectable, computed, inject, signal } from '@angular/core';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { DeviceService } from './device.service';

/**
 * Allows child pages to communicate with the navbar (e.g., hero pages setting a title).
 */
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
  /**
   * User preference: whether the sidebar should stay pinned at lg breakpoint
   * even on form-factors that default to a drawer (tablet). Persisted in
   * localStorage. Desktop and TV are always pinned regardless of this flag;
   * phones never have a sidebar.
   */
  readonly sidebarPinned = signal(localStorage.getItem('fliks.sidebarPinned') === 'true');
  /** Effective pin state for layout decisions — auto-disabled on narrow
   *  screens (e.g. tablet portrait < lg) where a pinned drawer would eat too
   *  much horizontal space and leave the user without the standard mobile
   *  navbar (= no back button, no title). The user's stored preference is
   *  preserved; once the screen is wide enough again the pin is honoured. */
  readonly effectiveSidebarPinned = computed(
    () => this.sidebarPinned() && this.isLargeScreen(),
  );

  private readonly router = inject(Router);
  private readonly device = inject(DeviceService);
  /** Stack of in-app URLs we've visited (most recent last, current excluded). */
  private readonly history: string[] = [];
  /** Set while goBack() is navigating, so the NavigationEnd it triggers is
   *  treated as a "pop" (don't push the URL we're leaving back onto the
   *  stack — that would create a forward/back loop). */
  private isPoppingBack = false;
  /** Capacitor native platform — exposed so templates can branch on it. */
  readonly isNativePlatform = Capacitor.isNativePlatform();
  private get isNative() { return this.isNativePlatform; }
  /** True while the viewport matches Tailwind's `lg` breakpoint (≥1024px). */
  private readonly isLargeScreen = signal(false);
  private navCount = 0;

  constructor() {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(min-width: 1024px)');
      this.isLargeScreen.set(mq.matches);
      mq.addEventListener('change', (e) => this.isLargeScreen.set(e.matches));
    }
    // Empty, not `router.url`: this service is constructed before the router's
    // initial navigation, so seeding it would push a phantom '/' entry and make
    // the first hardware-back press on the entry screen a no-op redirect.
    let lastUrl = '';
    this.router.events.subscribe((e) => {
      // Browser back/forward: mirror the pop on our internal stack so the
      // next in-app back button doesn't re-push the URL we just left (which
      // would let goBack() walk *forward* into the page the user came back
      // from — e.g. media-detail → player → browser-back → "Retour" would
      // otherwise reopen the player).
      if (e instanceof NavigationStart && e.navigationTrigger === 'popstate') {
        // Only treat a popstate as a back-pop when it lands on the URL at the
        // top of our own stack. A stray popstate that doesn't (e.g. Android
        // dismissing the soft keyboard pops an IME history entry) must NOT set
        // isPoppingBack — otherwise it swallows the push for the *next* real
        // navigation, leaving that page with no back arrow and a dead back
        // gesture (reproduced by tapping a card from search with the keyboard
        // still open).
        if (this.history[this.history.length - 1] === e.url) {
          this.isPoppingBack = true;
          this.history.pop();
        }
      }
      if (e instanceof NavigationEnd) {
        this.navCount++;
        // Track the previous URL on every NavigationEnd. We can't trust
        // `window.history.back()` on Capacitor's Android WebView (SPA
        // pushState entries aren't reliably popped), so goBack() navigates
        // explicitly to the URL we recorded here. Skip the push when this
        // navigation IS a back-pop, otherwise back→back would just toggle
        // between two URLs forever.
        if (this.isPoppingBack) {
          this.isPoppingBack = false;
        } else if (lastUrl && this.pathOf(lastUrl) !== this.pathOf(e.urlAfterRedirects)) {
          // Only a real page change (path differs) pushes a back entry. A
          // query-only change on the same path — library tabs, filters, sort,
          // all written with replaceUrl — is in-page state, so back returns to
          // the previous PAGE, not the previous tab, matching browser back.
          this.history.push(lastUrl);
        }
        lastUrl = e.urlAfterRedirects;
        // Our own stack is empty right after a hard refresh (in-memory state
        // doesn't survive reload), but the real browser session history does
        // — fall back to it so the arrow doesn't vanish. Skipped on native:
        // Capacitor's WebView doesn't reliably track window.history either
        // (see goBack()'s comment).
        const hasRealHistory = !this.isNative && window.history.length > 1;
        this.canGoBack.set(
          (this.history.length > 0 || hasRealHistory) && this.router.url !== '/',
        );
      }
    });
  }

  /** URL path without query/fragment — query-only changes on the same path are
   *  in-page state (tabs / filters), not navigations to push onto the stack. */
  private pathOf(url: string): string {
    return url.split(/[?#]/)[0];
  }

  /**
   * Reset history tracking — called from top-level nav entries (home,
   * downloads, search, …). Click handlers fire *before* the resulting
   * `NavigationEnd`, so we also flip `isPoppingBack` to suppress the
   * push that would otherwise re-add the page we're leaving onto the
   * freshly-cleared stack — which is why the back arrow used to flash
   * on the first dock click and only disappear on the second.
   */
  resetNavHistory() {
    this.navCount = 0;
    this.history.length = 0;
    this.isPoppingBack = true;
    this.canGoBack.set(false);
  }

  /**
   * Mark the next navigation as a "going back" event so the resulting
   * NavigationEnd doesn't push the URL we're leaving onto the history stack.
   * Used by callers that navigate via Router directly (e.g. the player's
   * onBack() does a replaceUrl jump to the media detail) but want the
   * subsequent back press to skip over the URL they came from.
   */
  markAsBackNavigation() {
    this.isPoppingBack = true;
  }

  /**
   * Navigate back in browser history when possible; otherwise fall back to a
   * provided route (useful for deep-link entries where there is no history).
   * When no fallback is given and there's no history, goes to the home page.
   */
  /** Set when goBack() is currently navigating; consumed by the destination
   *  page's ngOnInit to decide between restoring focus vs. landing default. */
  readonly lastWasBack = signal(false);

  goBack(fallback?: readonly (string | number)[]): void {
    const prev = this.history.pop();
    if (prev) {
      this.isPoppingBack = true;
      this.lastWasBack.set(true);
      void this.router.navigateByUrl(prev).then(() => {
        // Reset on the next macrotask so the destination ngOnInit observes
        // it as `true`, but later programmatic navs from that page see `false`.
        setTimeout(() => this.lastWasBack.set(false), 0);
      });
      return;
    }
    if (!this.isNative && window.history.length > 1) {
      this.isPoppingBack = true;
      this.lastWasBack.set(true);
      const sub = this.router.events.subscribe((e) => {
        if (e instanceof NavigationEnd) {
          sub.unsubscribe();
          setTimeout(() => this.lastWasBack.set(false), 0);
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

  /** True when the top mobile navbar is actually rendered. The layout hides
   *  it on tablet when the user has pinned the sidebar (drawer takes over the
   *  primary nav), so we must mirror that condition — pages relying on this
   *  signal (e.g. media-info-header's back button) would otherwise leave the
   *  user without a back affordance and without the hero-page top padding. */
  readonly mobileNavbarVisible = computed(() => {
    // Mirror the layout's actual navbar visibility, not just the form-factor:
    // - desktop is always pinned → navbar hidden at lg+
    // - tablet & TV are user-pinnable → navbar hidden only when the user
    //   pinned the sidebar (effectiveSidebarPinned, gated on lg+)
    if (this.isLargeScreen() && this.device.isDesktop()) return false;
    if (
      (this.device.isTablet() || this.device.isTv()) &&
      this.effectiveSidebarPinned()
    ) {
      return false;
    }
    return true;
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
    // Re-evaluate scrollAtTop from the actual position. Without this, the
    // navbar stays opaque after returning from /watch — the scroll value
    // is whatever the previous page left it at and no scroll event fires
    // on a programmatic nav.
    if (typeof window !== 'undefined') {
      this.scrollAtTop.set(window.scrollY < 20);
    }
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
