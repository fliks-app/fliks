import { TestBed } from '@angular/core/testing';
import { Component, inject as ngInject } from '@angular/core';
import { provideRouter, Router, UrlTree } from '@angular/router';
import { NavbarService } from './navbar.service';
import { DeviceService } from './device.service';

@Component({ template: '' })
class PageStub {}

describe('NavbarService', () => {
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
});
