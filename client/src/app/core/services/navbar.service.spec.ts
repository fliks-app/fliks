import { TestBed } from '@angular/core/testing';
import { Component, inject as ngInject } from '@angular/core';
import { provideRouter, Router, UrlTree } from '@angular/router';
import { NavbarService } from './navbar.service';

@Component({ template: '' })
class PageStub {}

describe('NavbarService', () => {
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
