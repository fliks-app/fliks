import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AuthService } from './auth.service';
import { DeviceService } from './device.service';
import { hasPending } from './oidc';

const m = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', isPluginAvailable: () => true },
  registerPlugin: () => ({ start: m.start }),
}));
vi.mock('@capacitor/browser', () => ({ Browser: {} }));
vi.mock('@capacitor/app', () => ({ App: {} }));

describe('AuthService OpenID Connect on a phone shell', () => {
  let auth: AuthService;
  let http: HttpTestingController;
  let navigate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('isSecureContext', false);
    navigate = vi.fn().mockResolvedValue(true);
    m.start.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: Router, useValue: { navigateByUrl: navigate, events: { subscribe: () => undefined } } },
        { provide: DeviceService, useValue: { isTv: signal(false), tvPlatform: signal('none') } },
      ],
    });
    auth = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  const begin = async (): Promise<Promise<void>> => {
    const done = auth.oidcBegin(3);
    const req = await vi.waitFor(() => http.expectOne('/api/auth/oidc/3/start'));
    expect(req.request.body.returnTo).toBe('app');
    req.flush({ authorizeUrl: 'https://idp/a', state: 'st' });
    return done;
  };

  it('offers the sheet although the origin is not a secure context', async () => {
    m.start.mockRejectedValue({ code: 'canceled' });
    await begin();
    expect(m.start).toHaveBeenCalledWith({ url: 'https://idp/a', callbackScheme: 'media.fliks.app' });
  });

  it('sends the auth sheet result through /oidc/complete, errors and state included', async () => {
    m.start.mockResolvedValue({ url: 'media.fliks.app:/oidc/complete?error=not_allowed&state=st' });
    await begin();
    expect(navigate).toHaveBeenCalledWith('/oidc/complete?error=not_allowed&state=st');
    expect(hasPending('st')).toBe(true);
  });

  it('drops the pending entry when the sheet is dismissed', async () => {
    m.start.mockRejectedValue({ code: 'canceled' });
    await begin();
    expect(navigate).not.toHaveBeenCalled();
    expect(hasPending('st')).toBe(false);
  });
});
