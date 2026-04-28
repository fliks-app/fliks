import { Injectable, computed, inject, signal } from '@angular/core';
import { Location } from '@angular/common';
import { NavigationEnd, Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';

/**
 * Allows child pages to communicate with the navbar (e.g., hero pages setting a title).
 */
@Injectable({ providedIn: 'root' })
export class NavbarService {
  /** When set, the navbar shows this title instead of "Fliks" on scroll. */
  readonly heroTitle = signal('');
  /** Whether the current page has a hero fanart. */
  readonly isHeroPage = signal(false);
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

  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly isNative = Capacitor.isNativePlatform();
  /** True while the viewport matches Tailwind's `lg` breakpoint (≥1024px). */
  private readonly isLargeScreen = signal(false);
  private navCount = 0;

  constructor() {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(min-width: 1024px)');
      this.isLargeScreen.set(mq.matches);
      mq.addEventListener('change', (e) => this.isLargeScreen.set(e.matches));
    }
    this.router.events.subscribe((e) => {
      if (e instanceof NavigationEnd) {
        this.navCount++;
        this.canGoBack.set(this.navCount > 1 && this.router.url !== '/');
      }
    });
  }

  /** Reset history tracking — called when a top-level nav entry (home, library, …) is chosen. */
  resetNavHistory() {
    this.navCount = 0;
    this.canGoBack.set(false);
  }

  /**
   * Navigate back in browser history when possible; otherwise fall back to a
   * provided route (useful for deep-link entries where there is no history).
   * When no fallback is given and there's no history, goes to the home page.
   */
  goBack(fallback?: readonly (string | number)[]): void {
    if (this.canGoBack()) {
      this.location.back();
      return;
    }
    if (fallback?.length) {
      this.router.navigate([...fallback]);
    } else {
      this.router.navigate(['/']);
    }
  }

  /** True when the top mobile navbar is rendered (always on native, only <lg on web). */
  readonly mobileNavbarVisible = computed(() => this.isNative || !this.isLargeScreen());

  /** Mobile navbar center: hero title on fanart pages, otherwise static/dynamic page title. */
  readonly mobileNavTitle = computed(() =>
    this.isHeroPage() ? this.heroTitle() : this.pageTitle(),
  );

  /** True while the transparent hero-page navbar is shown (visible + hero page + scrolled at top). */
  readonly navbarTransparent = computed(
    () => this.mobileNavbarVisible() && this.scrollAtTop() && this.isHeroPage(),
  );

  /** Mark the current page as having a hero fanart (enables transparent navbar + white icons). */
  enterHeroPage(title: string) {
    document.body.classList.add('hero-page');
    this.isHeroPage.set(true);
    this.pageTitle.set('');
    this.heroTitle.set(title);
  }

  leaveHeroPage() {
    document.body.classList.remove('hero-page');
    this.isHeroPage.set(false);
    this.heroTitle.set('');
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
