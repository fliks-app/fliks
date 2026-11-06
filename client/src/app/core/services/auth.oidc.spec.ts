import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from './auth.service';
import { DeviceService } from './device.service';
import { lastProvider, noteOidcFailure, savePending, takePending, type OidcInfo } from './oidc';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const info = (over: Partial<OidcInfo> = {}): OidcInfo => ({
  providers: [{ id: 3, name: 'Authentik' }],
  autoLaunch: null,
  passwordLogin: 'everyone',
  origin: '',
  ...over,
});
const loginBody = { user: { id: 5, username: 'ada', permissions: [], isAdmin: false }, accessToken: 'a', refreshToken: 'r' };

describe('AuthService OpenID Connect', () => {
  let auth: AuthService;
  let http: HttpTestingController;
  let assign: ReturnType<typeof vi.fn>;
  let replace: ReturnType<typeof vi.fn>;
  let tv: ReturnType<typeof signal<boolean>>;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    assign = vi.fn();
    replace = vi.fn();
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('location', { origin: 'https://fliks.test', protocol: 'https:', href: 'https://fliks.test/', assign, replace });
    tv = signal(false);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: 'select-user', children: [] }]),
        { provide: DeviceService, useValue: { isTv: tv, tvPlatform: signal('none') } },
      ],
    });
    auth = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  const loadInfo = async (value: OidcInfo) => {
    const p = auth.oidcInfo();
    http.expectOne('/api/auth/oidc').flush(value);
    await p;
  };

  const pending = (over = {}) =>
    savePending({
      serverUrl: '',
      providerId: 3,
      state: 'st',
      verifier: 'ver',
      link: false,
      silent: false,
      expiresAt: Date.now() + 60_000,
      ...over,
    });

  describe('buttons', () => {
    it('shows the providers of the server', async () => {
      await loadInfo(info());
      expect(auth.ssoProviders().map((p) => p.name)).toEqual(['Authentik']);
    });

    it('shows none when the server is older (404)', async () => {
      const p = auth.oidcInfo();
      http.expectOne('/api/auth/oidc').flush('nope', { status: 404, statusText: 'Not Found' });
      await p;
      expect(auth.ssoProviders()).toEqual([]);
    });

    it('hides them on a TV', async () => {
      await loadInfo(info());
      tv.set(true);
      expect(auth.ssoProviders()).toEqual([]);
    });

    it('hides them where the shell has no auth bridge', async () => {
      await loadInfo(info());
      vi.stubGlobal('fliksDesktop', {});
      expect(auth.ssoProviders()).toEqual([]);
    });
  });

  describe('begin', () => {
    it('stores the verifier under the state, then leaves for the provider', async () => {
      void auth.oidcBegin(3);
      await settle();
      const req = http.expectOne('/api/auth/oidc/3/start');
      expect(req.request.body.returnTo).toBe('web');
      expect(req.request.body.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      req.flush({ authorizeUrl: 'https://idp/authorize?x=1', state: 'st1' });
      await settle();
      const stored = JSON.parse(sessionStorage.getItem('fliks.oidc.st1')!);
      expect(stored).toMatchObject({ providerId: 3, link: false, silent: false });
      expect(stored.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(replace).toHaveBeenCalledWith('https://idp/authorize?x=1');
    });

    it('asks for prompt=none on a silent re-run and a link on request', async () => {
      void auth.oidcBegin(3, { silent: true, link: true });
      const req = await vi.waitFor(() => http.expectOne('/api/auth/oidc/3/start'));
      expect(req.request.body).toMatchObject({ prompt: 'none', link: true });
      req.flush({ authorizeUrl: 'https://idp/a', state: 's2' });
    });
  });

  describe('complete', () => {
    it('refuses a state this client never started', async () => {
      const res = await auth.oidcReturned({ code: 'c', state: 'unknown' });
      expect(res).toMatchObject({ ok: false, kind: 'expired' });
      http.expectNone('/api/auth/oidc/exchange');
    });

    it('exchanges with the stored verifier, then starts the session', async () => {
      pending();
      const done = auth.oidcReturned({ code: 'c', state: 'st' });
      await settle();
      const req = http.expectOne('/api/auth/oidc/exchange');
      expect(req.request.body).toEqual({ state: 'st', code: 'c', verifier: 'ver' });
      req.flush(loginBody);
      expect(await done).toMatchObject({ ok: true });
      expect(auth.user()?.username).toBe('ada');
      expect(auth.refreshToken).toBe('r');
      expect(lastProvider('', 5)).toBe(3);
      expect(sessionStorage.getItem('fliks.oidc.st')).toBeNull();
    });

    it('turns a refusal into its error kind', async () => {
      pending();
      const done = auth.oidcReturned({ code: 'c', state: 'st' });
      await settle();
      http.expectOne('/api/auth/oidc/exchange').flush({ error: 'no_account' }, { status: 403, statusText: 'Forbidden' });
      expect(await done).toMatchObject({ ok: false, kind: 'no_account' });
      expect(auth.user()).toBeNull();
    });

    it('refreshes the profile after a link instead of signing in', async () => {
      pending({ link: true });
      const done = auth.oidcReturned({ code: 'c', state: 'st' });
      await settle();
      http.expectOne('/api/auth/oidc/exchange').flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      http.expectOne('/api/auth/me').flush({ ...loginBody.user });
      expect(await done).toMatchObject({ ok: true });
      expect(lastProvider('', 5)).toBeNull();
    });

    it('reports a provider error with the pending entry of its state', async () => {
      pending({ silent: true });
      const res = await auth.oidcReturned({ error: 'idp' }, 'st');
      expect(res).toMatchObject({ ok: false, kind: 'idp', pending: { silent: true } });
    });
  });

  describe('shell and context', () => {
    it('hides every button where Web Crypto is missing (plain http)', async () => {
      vi.stubGlobal('isSecureContext', false);
      await loadInfo(info());
      expect(auth.ssoProviders()).toHaveLength(0);
    });

    it('purges expired pending entries when it saves a new one', () => {
      pending({ state: 'old', expiresAt: Date.now() - 1 });
      pending({ state: 'fresh' });
      expect(sessionStorage.getItem('fliks.oidc.old')).toBeNull();
      expect(takePending('fresh')).not.toBeNull();
    });

    it('keeps the provider per account, not per server', async () => {
      await loadInfo(info());
      pending();
      const done = auth.oidcReturned({ code: 'c', state: 'st' });
      await settle();
      http.expectOne('/api/auth/oidc/exchange').flush(loginBody);
      await done;
      expect(lastProvider('', 5)).toBe(3);
      expect(lastProvider('', 6)).toBeNull();
    });
  });

  describe('origin redirect', () => {
    it('moves to the public origin before starting', async () => {
      await loadInfo(info({ origin: 'https://public.test' }));
      await auth.oidcSignIn(3);
      expect(assign).toHaveBeenCalledWith('https://public.test/login?sso=3');
      http.expectNone('/api/auth/oidc/3/start');
    });

    it('starts in place when already on the public origin', async () => {
      await loadInfo(info({ origin: 'https://fliks.test' }));
      void auth.oidcSignIn(3);
      const req = await vi.waitFor(() => http.expectOne('/api/auth/oidc/3/start'));
      req.flush({ authorizeUrl: 'https://idp/a', state: 's3' });
    });
  });

  describe('auto-launch', () => {
    const launched = async () => {
      await settle();
      return http.match('/api/auth/oidc/3/start').length > 0;
    };

    it('starts the configured provider', async () => {
      await loadInfo(info({ autoLaunch: 3 }));
      expect(auth.oidcAutoLaunch(false)).toBe(true);
      expect(await launched()).toBe(true);
    });

    it('stays off with autoLaunch=0, on a TV, and with no provider configured', async () => {
      await loadInfo(info({ autoLaunch: 3 }));
      expect(auth.oidcAutoLaunch(true)).toBe(false);
      tv.set(true);
      expect(auth.oidcAutoLaunch(false)).toBe(false);
      tv.set(false);
      await loadInfo(info({ autoLaunch: null }));
      expect(auth.oidcAutoLaunch(false)).toBe(false);
    });

    it('stops for a minute after an error or a cancel (loop guard)', async () => {
      await loadInfo(info({ autoLaunch: 3 }));
      noteOidcFailure();
      expect(auth.oidcAutoLaunch(false)).toBe(false);
    });
  });

  describe('session cap', () => {
    const expired = { status: 401, statusText: 'Unauthorized' };

    async function signedInViaProvider() {
      await loadInfo(info());
      pending();
      const done = auth.oidcReturned({ code: 'c', state: 'st' });
      await settle();
      http.expectOne('/api/auth/oidc/exchange').flush(loginBody);
      await done;
    }

    it('re-runs the last provider silently after "Refresh token expired"', async () => {
      await signedInViaProvider();
      const refreshed = auth.refreshAccessToken();
      await settle();
      http.expectOne('/api/auth/refresh').flush({ message: 'Refresh token expired' }, expired);
      expect(await refreshed).toBe(false);
      await settle();
      expect(http.expectOne('/api/auth/oidc/3/start').request.body.prompt).toBe('none');
    });

    it('skips the silent run on a host that is not the public origin, and says so', async () => {
      await signedInViaProvider();
      await loadInfo(info({ origin: 'https://public.test' }));
      expect(auth.ssoOtherOrigin()).toBe(true);
      const refreshed = auth.refreshAccessToken();
      await settle();
      http.expectOne('/api/auth/refresh').flush({ message: 'Refresh token expired' }, expired);
      await refreshed;
      await settle();
      http.expectNone('/api/auth/oidc/3/start');
    });

    it('does not re-run after another kind of refusal, or right after a failure', async () => {
      await signedInViaProvider();
      const refreshed = auth.refreshAccessToken();
      await settle();
      http.expectOne('/api/auth/refresh').flush({ message: 'Invalid refresh token' }, expired);
      await refreshed;
      await settle();
      http.expectNone('/api/auth/oidc/3/start');
    });
  });

  it('forgets the provider after a password login', async () => {
    pending();
    const done = auth.oidcReturned({ code: 'c', state: 'st' });
    await settle();
    http.expectOne('/api/auth/oidc/exchange').flush(loginBody);
    await done;
    const login = auth.login('ada', 'pw');
    await settle();
    http.expectOne('/api/auth/login').flush(loginBody);
    await login;
    expect(lastProvider('', 5)).toBeNull();
  });
});
