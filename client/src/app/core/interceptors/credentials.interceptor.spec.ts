import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClient, HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { ServerConfigService } from '../services/server-config.service';
import { credentialsInterceptor, targetsActiveServer } from './credentials.interceptor';

describe('targetsActiveServer', () => {
  it('accepts relative API paths', () => {
    expect(targetsActiveServer('/api/auth/me', '')).toBe(true);
    expect(targetsActiveServer('/api/media/1', 'http://tv.lan:3000')).toBe(true);
  });

  it('accepts absolute URLs under the active server', () => {
    expect(
      targetsActiveServer('http://tv.lan:3000/api/auth/me', 'http://tv.lan:3000'),
    ).toBe(true);
  });

  it('refuses a host the user merely typed — the session must not leak to it', () => {
    expect(
      targetsActiveServer('http://evil.example/api/auth/me', 'http://tv.lan:3000'),
    ).toBe(false);
    expect(targetsActiveServer('http://tv.lan:3000/api/auth/me', '')).toBe(false);
  });

  it('ignores anything that is not an API call', () => {
    expect(targetsActiveServer('/i18n/fr.json', '')).toBe(false);
    expect(targetsActiveServer('https://image.tmdb.org/t/p/w500/x.jpg', '')).toBe(false);
  });
});

describe('credentialsInterceptor refresh failure', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;
  const auth = { accessToken: 'a', refreshToken: 'r' as string | null, refreshAccessToken: vi.fn() };

  beforeEach(() => {
    auth.refreshToken = 'r';
    auth.refreshAccessToken.mockReset().mockResolvedValue(false);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([credentialsInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: auth },
        { provide: ServerConfigService, useValue: { serverUrl: () => '', isNative: false } },
      ],
    });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
  });

  async function failedStatus(): Promise<number> {
    const result = firstValueFrom(http.get('/api/auth/me')).then(
      () => -1,
      (e: HttpErrorResponse) => e.status,
    );
    ctrl.expectOne('/api/auth/me').flush('', { status: 401, statusText: 'Unauthorized' });
    return result;
  }

  it('surfaces a transient refresh failure as status 0 while the session survives', async () => {
    expect(await failedStatus()).toBe(0);
  });

  it('keeps the 401 once the session has been dropped', async () => {
    auth.refreshAccessToken.mockImplementation(async () => {
      auth.refreshToken = null;
      return false;
    });
    expect(await failedStatus()).toBe(401);
  });
});
