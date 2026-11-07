import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { BehaviorSubject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/services/auth.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { LoginComponent } from './login';

function setup(opts: { query?: Record<string, string>; providers?: { id: number; name: string }[]; passwordLogin?: string } = {}) {
  const auth = {
    listUsersPublic: vi.fn(async () => []),
    resumableSessions: () => [],
    oidcInfo: vi.fn(async () => undefined),
    oidcBegin: vi.fn(async () => undefined),
    oidcAutoLaunch: vi.fn(() => false),
    oidcSignIn: vi.fn(async () => undefined),
    oidcBusy: signal(false),
    ssoProviders: signal(opts.providers ?? []),
    passwordLogin: signal(opts.passwordLogin ?? 'everyone'),
  };
  const queryParamMap = new Map(Object.entries(opts.query ?? {}));
  const queryParams$ = new BehaviorSubject(convertToParamMap(opts.query ?? {}));
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: AuthService, useValue: auth },
      { provide: Router, useValue: { navigate: vi.fn() } },
      { provide: ServerConfigService, useValue: { lastUsernameForActiveServer: () => null } },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap }, queryParamMap: queryParams$ } },
    ],
  });
  const router = TestBed.inject(Router) as unknown as { navigate: ReturnType<typeof vi.fn> };
  const fixture = TestBed.createComponent(LoginComponent);
  fixture.detectChanges();
  return { auth, router, fixture, queryParams$, el: fixture.nativeElement as HTMLElement };
}

describe('LoginComponent SSO', () => {
  it('shows no SSO button and keeps the form when there is no provider', () => {
    const { el } = setup();
    expect(el.querySelectorAll('[data-testid="sso-button"]').length).toBe(0);
    expect(el.querySelector('#username')).not.toBeNull();
  });

  it('shows a button per provider under the form', () => {
    const { el } = setup({ providers: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] });
    expect(el.querySelectorAll('[data-testid="sso-button"]').length).toBe(2);
    expect(el.querySelector('#username')).not.toBeNull();
  });

  it('folds the password form behind "Administrator sign-in" when passwords are admin-only', () => {
    const { el, fixture } = setup({ providers: [{ id: 1, name: 'A' }], passwordLogin: 'admins' });
    expect(el.querySelector('#username')).toBeNull();
    (el.querySelector('[data-testid="admin-sign-in"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelector('#username')).not.toBeNull();
  });

  it('keeps the form when passwords are admin-only but this shell has no working button', () => {
    const { el } = setup({ providers: [], passwordLogin: 'admins' });
    expect(el.querySelector('#username')).not.toBeNull();
  });

  it('shows the error of a failed sign-in that lands on the page already open', () => {
    const { el, fixture, queryParams$ } = setup();
    expect(el.textContent).not.toContain('oidc.error');
    queryParams$.next(convertToParamMap({ oidcError: 'idp' }));
    fixture.detectChanges();
    expect(el.textContent).toContain('oidc.error.idp');
  });

  it('starts the provider named by ?sso= (origin redirect)', async () => {
    const { auth } = setup({ query: { sso: '4' } });
    await vi.waitFor(() => expect(auth.oidcBegin).toHaveBeenCalledWith(4));
    expect(auth.oidcAutoLaunch).not.toHaveBeenCalled();
  });

  it('strips ?sso= from the history entry before starting', async () => {
    const { router } = setup({ query: { sso: '4' } });
    await vi.waitFor(() =>
      expect(router.navigate).toHaveBeenCalledWith([], {
        queryParams: { sso: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      }),
    );
  });

  it('asks for auto-launch, suppressed by ?autoLaunch=0', async () => {
    const { auth } = setup({ query: { autoLaunch: '0' } });
    await vi.waitFor(() => expect(auth.oidcAutoLaunch).toHaveBeenCalledWith(true));
  });

  it('goToSelectUser keeps SSO from auto-launching', () => {
    const { router, fixture } = setup();
    fixture.componentInstance.goToSelectUser();
    expect(router.navigate).toHaveBeenCalledWith(['/select-user'], { queryParams: { autoLaunch: 0 } });
  });
});
