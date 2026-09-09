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

  /** Never a docked sidebar on a TV: the main layout there is a 10-foot browse
   *  surface, a permanent column steals from it, and focus would have one more
   *  region to escape on every screen. */
  it('never docks the sidebar on a TV, whatever the pin preference says', () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', component: PageStub }]),
        {
          provide: DeviceService,
          useValue: {
            isTv: () => true,
            isTablet: () => false,
            isDesktop: () => false,
          } as unknown as DeviceService,
        },
      ],
    });
    const navbar = TestBed.inject(NavbarService);

    expect(navbar.sidebarPinned()).toBe(true);
    expect(navbar.effectiveSidebarPinned()).toBe(false);
    expect(navbar.sidebarDocked()).toBe(false);
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
});
