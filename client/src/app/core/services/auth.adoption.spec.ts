import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService, type User } from './auth.service';
import { SessionStoreService } from './session-store.service';
import { SKIP_ERROR_TOAST } from '../interceptors/error.interceptor';

const user = { id: 1, username: 'u', avatar: null, permissions: [] } as unknown as User;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('AuthService refresh token adoption', () => {
  let auth: AuthService;
  let http: HttpTestingController;

  const stored = (refreshToken: string, tokenVersion: number) =>
    localStorage.setItem(
      'fliks_sessions',
      JSON.stringify([
        {
          serverUrl: '',
          user,
          accessToken: null,
          refreshToken,
          refreshExpiresAt: null,
          lastUsedAt: 1,
          tokenVersion,
        },
      ]),
    );

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: 'select-user', children: [] }]),
      ],
    });
    auth = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
    stored('T3', 3);
    await TestBed.inject(SessionStoreService).load();
    await TestBed.inject(SessionStoreService).setActive('', 1);
    auth.loadPersistedSession();
  });

  it('never adopts a stored token older than the one in hand', async () => {
    stored('T1', 1);
    const refresh = auth.refreshAccessToken();
    await settle();
    const request = http.expectOne('/api/auth/refresh');
    expect(request.request.body.refreshToken).toBe('T3');
    expect(request.request.context.get(SKIP_ERROR_TOAST)).toBe(true);
    request.flush({ accessToken: 'a', refreshToken: 'T4' });
    await refresh;
  });

  it('adopts a stored token that is strictly newer without a round-trip', async () => {
    stored('T9', 9);
    expect(await auth.refreshAccessToken()).toBe(true);
    http.expectNone('/api/auth/refresh');
    expect(auth.refreshToken).toBe('T9');
  });
});
