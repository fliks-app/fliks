import { TestBed } from '@angular/core/testing';
import { Component, inject as ngInject } from '@angular/core';
import { provideRouter, Router, UrlTree } from '@angular/router';
import { NavbarService } from './navbar.service';
import { DeviceService } from './device.service';

@Component({ template: '' })
class PageStub {}

/** `TestBed` mocks the platform location, so the router never reaches the real
 *  session history that NavbarService falls back to: state it per test. */
function pinSessionHistoryLength(length: number): void {
  Object.defineProperty(window.history, 'length', { configurable: true, get: () => length });
}

describe('NavbarService', () => {
  afterEach(() => {
    delete (window.history as unknown as { length?: number }).length;
  });

  /** `railMode` per form factor and width: the one value the layout, the player bar and the page clearances read. */
  describe('railMode', () => {
    const realMatchMedia = window.matchMedia;
    afterEach(() => {
      window.matchMedia = realMatchMedia;
      localStorage.removeItem('fliks.sidebarPinned');
    });

    const make = (form: 'tv' | 'phone' | 'tablet' | 'desktop', width: number, pinned = true) => {
      window.matchMedia = ((q: string) => {
        const min = Number(/min-width:\s*(\d+)px/.exec(q)?.[1] ?? 0);
        return { matches: width >= min, addEventListener: () => {}, removeEventListener: () => {} } as unknown as MediaQueryList;
      }) as typeof window.matchMedia;
      if (pinned) localStorage.removeItem('fliks.sidebarPinned');
      else localStorage.setItem('fliks.sidebarPinned', 'false');
      TestBed.configureTestingModule({
        providers: [
          provideRouter([{ path: '**', component: PageStub }]),
          {
            provide: DeviceService,
            useValue: {
              isTv: () => form === 'tv',
              isPhone: () => form === 'phone',
              isTablet: () => form === 'tablet',
              isDesktop: () => form === 'desktop',
            } as unknown as DeviceService,
          },
        ],
      });
      return TestBed.inject(NavbarService);
    };

    it('is collapsed on a TV, whatever the pin preference says', () => {
      expect(make('tv', 1920, true).railMode()).toBe('collapsed');
    });

    it('keeps a desktop expanded at lg and up whatever the pin says, and a tablet until unpinned', () => {
      expect(make('desktop', 1280).railMode()).toBe('expanded');
      TestBed.resetTestingModule();
      expect(make('desktop', 1280, false).railMode()).toBe('expanded');
      TestBed.resetTestingModule();
      expect(make('tablet', 1280).railMode()).toBe('expanded');
      TestBed.resetTestingModule();
      expect(make('tablet', 1280, false).railMode()).toBe('collapsed');
    });

    it('offers the pin on a tablet only', () => {
      expect(make('tablet', 1280).canPin()).toBe(true);
      TestBed.resetTestingModule();
      expect(make('desktop', 1280).canPin()).toBe(false);
      TestBed.resetTestingModule();
      expect(make('tv', 1920).canPin()).toBe(false);
    });

    it('stays collapsed between md and lg even when pinned', () => {
      expect(make('desktop', 900).railMode()).toBe('collapsed');
    });

    it('is a drawer below md and on a phone', () => {
      expect(make('tablet', 600).railMode()).toBe('drawer');
      TestBed.resetTestingModule();
      expect(make('phone', 1000).railMode()).toBe('drawer');
    });

    it('shows the mobile navbar only where the rail is not docked', () => {
      const docked = make('desktop', 1280);
      expect(docked.railDocked()).toBe(true);
      expect(docked.mobileNavbarVisible()).toBe(false);
      TestBed.resetTestingModule();
      const drawer = make('desktop', 600);
      expect(drawer.railDocked()).toBe(false);
      expect(drawer.mobileNavbarVisible()).toBe(true);
    });
  });

  it('clears the mobile navbar with a hero padding only off a TV and on a hero page', () => {
    const make = (isTv: boolean) => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          provideRouter([{ path: '**', component: PageStub }]),
          { provide: DeviceService, useValue: { isTv: () => isTv, isPhone: () => false, isTablet: () => false, isDesktop: () => false } as unknown as DeviceService },
        ],
      });
      const navbar = TestBed.inject(NavbarService);
      navbar.isHeroPage.set(true);
      return navbar;
    };
    const phone = make(false);
    expect(phone.heroPaddingTop()).toContain('3rem');
    phone.isHeroPage.set(false);
    expect(phone.heroPaddingTop()).toBeNull();
    expect(make(true).heroPaddingTop()).toBeNull();
  });

  /** Entry screens are reached through a guard redirect (Tizen boots into
   *  /setup). A back entry recorded there makes the first hardware-back press
   *  a no-op redirect instead of leaving the app — Samsung rejects that. */
  it('has no back entry on an entry screen reached through a guard redirect', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'setup', component: PageStub },
          {
            path: '',
            component: PageStub,
            canActivate: [() => ngInject(Router).createUrlTree(['/setup']) as UrlTree],
          },
        ]),
      ],
    });

    // Construction order matches the real app: injected by App's DI, before the
    // router runs its initial navigation.
    const navbar = TestBed.inject(NavbarService);
    await TestBed.inject(Router).navigateByUrl('/');

    expect(navbar.canGoBack()).toBe(false);
  });

  /** The artwork reveal replays whenever a cached subtree is re-inserted, so a
   *  page returned to would re-announce art the user was already looking at. */
  it('flags the document on a back navigation and clears it on a forward one', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: PageStub },
          { path: 'library', component: PageStub },
        ]),
      ],
    });

    const navbar = TestBed.inject(NavbarService);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/');
    await router.navigateByUrl('/library');
    expect(document.documentElement.classList.contains('nav-back')).toBe(false);

    navbar.goBack();
    // goBack() releases `lastWasBack` a macrotask after its navigation settles,
    // so the forward hop below has to come after that, not inside the same tick.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.documentElement.classList.contains('nav-back')).toBe(true);

    await router.navigateByUrl('/library');
    expect(document.documentElement.classList.contains('nav-back')).toBe(false);
  });

  /** A resolver error or an unloaded lazy chunk around a background/resume
   *  gap rejects the return navigate — this must not strand the flag `true`. */
  it('clears lastWasBack even when the return navigation rejects', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: PageStub },
          { path: 'library', component: PageStub },
        ]),
      ],
    });

    const navbar = TestBed.inject(NavbarService);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/');
    await router.navigateByUrl('/library');

    vi.spyOn(router, 'navigateByUrl').mockReturnValue(Promise.reject(new Error('boom')));

    navbar.goBack();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(navbar.lastWasBack()).toBe(false);
  });

  /** goBack() only closes `lastWasBack` a macrotask after its own navigation
   *  settles; a push that starts inside that window must not read as a return
   *  too, or the page-slide stack spends a pop the push never earned. */
  it("does not read a push started during goBack()'s own window as a return", async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: PageStub },
          { path: 'library', component: PageStub },
          { path: 'movies', component: PageStub },
          { path: 'search', component: PageStub },
        ]),
      ],
    });

    const navbar = TestBed.inject(NavbarService);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/');
    await router.navigateByUrl('/library');
    await router.navigateByUrl('/movies');

    navbar.goBack();
    // No await in between: this push starts while goBack()'s own navigation to
    // /library is still in flight, superseding it before lastWasBack resets.
    await router.navigateByUrl('/search');

    expect(router.url).toBe('/search');
    expect(document.documentElement.classList.contains('nav-back')).toBe(false);
  });

  it('records a back entry once a real in-app navigation happens', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: PageStub },
          { path: 'library', component: PageStub },
        ]),
      ],
    });

    const navbar = TestBed.inject(NavbarService);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/');
    await router.navigateByUrl('/library');

    expect(navbar.canGoBack()).toBe(true);
  });

  /** A non-root target on purpose: on `/` the arrow is already ruled out by the
   *  route itself, so nothing there depends on the root-entry intent. */
  it('clears the back entry when the navigation itself is marked a root entry', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: PageStub },
          { path: 'library', component: PageStub },
          { path: 'search', component: PageStub },
        ]),
      ],
    });

    const navbar = TestBed.inject(NavbarService);
    const router = TestBed.inject(Router);
    // The browser's own session history still answers for a hard refresh, and
    // a top-level entry has to outrank it.
    pinSessionHistoryLength(2);
    await router.navigateByUrl('/');
    await router.navigateByUrl('/library');
    expect(navbar.canGoBack()).toBe(true);

    // What a top-level dock entry does: the intent rides on the navigation, so
    // the arrow can only clear once the router has actually landed.
    await router.navigate(['/search'], { state: { rootEntry: true } });

    expect(navbar.canGoBack()).toBe(false);
  });

  it('drops the pages visited before a root entry, and records again after it', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: PageStub },
          { path: 'library', component: PageStub },
          { path: 'movies', component: PageStub },
          { path: 'search', component: PageStub },
        ]),
      ],
    });

    const navbar = TestBed.inject(NavbarService);
    const router = TestBed.inject(Router);
    // An emptied stack must reach goBack()'s own fallback rather than the
    // browser's history, which would answer for it.
    pinSessionHistoryLength(1);
    await router.navigateByUrl('/');
    await router.navigateByUrl('/library');
    await router.navigateByUrl('/movies');
    await router.navigate(['/search'], { state: { rootEntry: true } });
    await router.navigateByUrl('/library');
    expect(navbar.canGoBack()).toBe(true);

    navbar.goBack();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(router.url).toBe('/search');

    navbar.goBack();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Nothing recorded before the top-level entry survives it, so back leaves
    // for the home route instead of walking into the branch it came from.
    expect(router.url).toBe('/');
  });
  /** The player's own exits replace /watch, but a remount detours through `/`
   *  and records it as a page; back from the detail page must not reopen it. */
  it('never records a player URL as a back target', async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: '**', component: PageStub }])],
    });
    const navbar = TestBed.inject(NavbarService);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/movies/1');
    await router.navigateByUrl('/watch/1');
    await router.navigateByUrl('/', { skipLocationChange: true });
    await router.navigateByUrl('/watch/2', { replaceUrl: true });
    navbar.markAsBackNavigation();
    await router.navigateByUrl('/movies/1', { replaceUrl: true });

    expect(navbar.backDepth).toBe(2);
    navbar.goBack();
    await new Promise((resolve) => setTimeout(resolve, 10));
    navbar.goBack();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(router.url).not.toMatch(/^\/watch/);
  });
});
