import { Injectable, computed, signal } from '@angular/core';
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

  private readonly isNative = Capacitor.isNativePlatform();
  /** True while the viewport matches Tailwind's `lg` breakpoint (≥1024px). */
  private readonly isLargeScreen = signal(false);

  constructor() {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(min-width: 1024px)');
      this.isLargeScreen.set(mq.matches);
      mq.addEventListener('change', (e) => this.isLargeScreen.set(e.matches));
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

  /** Sets the in-layout page title (ignored while on a hero page). */
  setPageTitle(title: string) {
    if (this.isHeroPage()) return;
    this.pageTitle.set(title);
  }

  clearPageTitle() {
    this.pageTitle.set('');
  }
}
