import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { OidcCompleteComponent } from './oidc-complete';

async function run(fragment: string, result: unknown) {
  const oidcReturned = vi.fn(async () => result);
  const navigate = vi.fn(async () => true);
  const error = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: AuthService, useValue: { oidcReturned } },
      { provide: Router, useValue: { navigate } },
      { provide: ToastService, useValue: { error } },
      { provide: ActivatedRoute, useValue: { snapshot: { fragment, queryParamMap: new Map() } } },
    ],
  });
  await TestBed.createComponent(OidcCompleteComponent).componentInstance.ngOnInit();
  return { oidcReturned, navigate, error };
}

describe('OidcCompleteComponent', () => {
  it('completes with the code and state of the fragment, then goes home', async () => {
    const { oidcReturned, navigate } = await run('code=abc&state=xyz', { ok: true, pending: { link: false } });
    expect(oidcReturned).toHaveBeenCalledWith({ code: 'abc', state: 'xyz' });
    expect(navigate).toHaveBeenCalledWith(['/'], { replaceUrl: true });
  });

  it('goes back to the account page after a link', async () => {
    const { navigate } = await run('code=abc&state=xyz', { ok: true, pending: { link: true } });
    expect(navigate).toHaveBeenCalledWith(['/account'], { replaceUrl: true });
  });

  it('sends an error back to the login page with its kind and no auto-launch', async () => {
    const { oidcReturned, navigate } = await run('error=idp&state=xyz', {
      ok: false,
      kind: 'idp',
      pending: { link: false, silent: false },
    });
    expect(oidcReturned).toHaveBeenCalledWith({ error: 'idp' }, 'xyz');
    expect(navigate).toHaveBeenCalledWith(['/login'], {
      replaceUrl: true,
      queryParams: { autoLaunch: 0, oidcError: 'idp' },
    });
  });

  it('says nothing when a silent re-run is refused', async () => {
    const { navigate } = await run('error=idp&state=xyz', {
      ok: false,
      kind: 'idp',
      pending: { link: false, silent: true },
    });
    expect(navigate).toHaveBeenCalledWith(['/login'], { replaceUrl: true, queryParams: { autoLaunch: 0 } });
  });

  it('treats a callback without code or state as expired', async () => {
    const { oidcReturned } = await run('', { ok: false, kind: 'expired', pending: null });
    expect(oidcReturned).toHaveBeenCalledWith({ error: 'expired' }, undefined);
  });
});
