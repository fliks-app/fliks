import { TestBed } from '@angular/core/testing';
import { Component, ElementRef, inject as ngInject, signal } from '@angular/core';
import { NavigationEnd, provideRouter, Router, RouteReuseStrategy, RouterOutlet, UrlTree } from '@angular/router';
import { filter, take } from 'rxjs';
import { HeroChrome, HeroPage, NavbarService } from './navbar.service';
import { DeviceService } from './device.service';
import { CachingReuseStrategy } from './route-reuse.strategy';

@Component({ template: '' })
class PageStub {}

@Component({ template: '' })
class HeroPageStub implements HeroPage {
  readonly heroChrome = signal<HeroChrome | null>({ host: ngInject(ElementRef).nativeElement });
}

/** The layout's outlet wiring. */
@Component({
  imports: [RouterOutlet],
  template: '<router-outlet (activate)="navbar.showPage($event)" (attach)="navbar.showPage($event)" />',
})
class OutletHost {
  readonly navbar = ngInject(NavbarService);
}

const heroPage = (chrome: Partial<HeroChrome> = {}) => ({
  heroChrome: signal<HeroChrome | null>({ host: document.createElement('div'), ...chrome }),
});

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
    });

    const make = (form: 'tv' | 'phone' | 'tablet' | 'desktop', width: number) => {
      window.matchMedia = ((q: string) => {
        const min = Number(/min-width:\s*(\d+)px/.exec(q)?.[1] ?? 0);
        return { matches: width >= min, addEventListener: () => {}, removeEventListener: () => {} } as unknown as MediaQueryList;
      }) as typeof window.matchMedia;
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

    it('is collapsed on a TV', () => {
      expect(make('tv', 1920).railMode()).toBe('collapsed');
    });

    it('keeps a desktop and a tablet expanded at lg and up', () => {
      expect(make('desktop', 1280).railMode()).toBe('expanded');
      TestBed.resetTestingModule();
      expect(make('tablet', 1280).railMode()).toBe('expanded');
    });

    it('stays collapsed between md and lg', () => {
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
      navbar.showPage(heroPage());
      return navbar;
    };
    const phone = make(false);
    expect(phone.heroPaddingTop()).toContain('3rem');
    phone.showPage(null);
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

  it('reads the hero chrome off the page shown, and follows its changes', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const navbar = TestBed.inject(NavbarService);
    const page = heroPage({ title: 'T' });
    navbar.showPage(page);
    expect([navbar.isHeroPage(), navbar.heroTitle(), navbar.heroBrand()]).toEqual([true, 'T', false]);
    expect(document.body.classList.contains('hero-page')).toBe(true);
    page.heroChrome.set(null);
    TestBed.tick();
    expect(navbar.isHeroPage()).toBe(false);
    expect(document.body.classList.contains('hero-page')).toBe(false);
    navbar.showPage({});
    expect(navbar.isHeroPage()).toBe(false);
  });

  it('sets the hero class as the outlet inserts a cached hero page, before NavigationEnd', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', pathMatch: 'full', component: HeroPageStub, data: { reuse: true } },
          { path: 'b', component: PageStub },
        ]),
        { provide: RouteReuseStrategy, useClass: CachingReuseStrategy },
        { provide: DeviceService, useValue: { isTv: () => false, isPhone: () => false, isTablet: () => false, isDesktop: () => true, reducedEffects: () => false } as unknown as DeviceService },
      ],
    });
    const fixture = TestBed.createComponent(OutletHost);
    fixture.detectChanges();
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/');
    await router.navigateByUrl('/b');
    expect(document.body.classList.contains('hero-page')).toBe(false);
    let atEnd: boolean | undefined;
    router.events.pipe(filter((e) => e instanceof NavigationEnd), take(1)).subscribe(() => {
      atEnd = document.body.classList.contains('hero-page');
    });
    await router.navigateByUrl('/');
    expect(atEnd).toBe(true);
    fixture.destroy();
    TestBed.inject(NavbarService).showPage(null);
  });

  it('keeps the page title through a hero claim and gives a returning path its own back', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([{ path: 'a', component: PageStub }, { path: 'b', component: PageStub }])] });
    const navbar = TestBed.inject(NavbarService);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/a');
    navbar.setPageTitle('A', { name: 'film' });
    navbar.showPage(heroPage());
    expect([navbar.pageTitle(), navbar.pageIcon()]).toEqual(['A', { name: 'film' }]);
    await router.navigateByUrl('/b');
    expect(navbar.pageTitle()).toBe('');
    await router.navigateByUrl('/a?view=genres');
    expect([navbar.pageTitle(), navbar.pageIcon()]).toEqual(['A', { name: 'film' }]);
  });

  it('keeps the phone bar clear only while the claimed page picture is under it', () => {
    let fire!: (hit: boolean) => void;
    const observed: Element[] = [];
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: (e: { isIntersecting: boolean; target: Element }[]) => void) { fire = (hit) => cb([{ isIntersecting: hit, target: observed[0] }]); }
      observe(el: Element) { observed.push(el); }
      disconnect() {}
    });
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const navbar = TestBed.inject(NavbarService);
    const host = document.createElement('div');
    host.innerHTML = '<div data-hero-picture></div>';
    document.body.append(host);
    navbar.showPage(heroPage({ host }));
    TestBed.tick();
    expect(observed[0]).toBe(host.firstElementChild);
    fire(false);
    expect(navbar.heroUnderBar()).toBe(false);
    fire(true);
    expect(navbar.heroUnderBar()).toBe(true);
    navbar.showPage(null);
    host.remove();
    vi.unstubAllGlobals();
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
