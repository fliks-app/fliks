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

const user = (id: number): User =>
  ({ id, username: `user${id}`, avatar: null, permissions: [] }) as unknown as User;

const IN_AN_HOUR = Math.floor(Date.now() / 1000) + 3600;
const TOKEN_PAIR = {
  accessToken: 'access-2',
  refreshToken: 'refresh-2',
  accessTokenExpiresAt: IN_AN_HOUR,
  refreshTokenExpiresAt: IN_AN_HOUR,
};

/** Let the awaits inside the service settle before asserting on requests. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A refresh in flight for the account being left must never install its rotated
 * pair over the session that took over: the screen would belong to one account
 * and every request to the other.
 */
describe('AuthService session switching', () => {
  let auth: AuthService;
  let sessions: SessionStoreService;
  let http: HttpTestingController;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        // dropActiveSession() sends the user back to the picker.
        provideRouter([{ path: 'select-user', children: [] }]),
      ],
    });
    auth = TestBed.inject(AuthService);
    sessions = TestBed.inject(SessionStoreService);
    http = TestBed.inject(HttpTestingController);

    await sessions.save({
      serverUrl: '',
      user: user(1),
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      refreshExpiresAt: null,
      lastUsedAt: 1,
    });
    await sessions.setActive('', 1);
    auth.loadPersistedSession();
  });

  /** Web clears its access cookie server-side when leaving an account. */
  async function switchUser(): Promise<void> {
    const switching = auth.beginUserSwitch();
    await settle();
    http.expectOne('/api/auth/logout').flush(null, { status: 204, statusText: '' });
    await switching;
  }

  it('keeps the rotated pair out of memory when the session changed mid-flight', async () => {
    const rotation = auth.refreshAccessToken();
    await settle();
    const request = http.expectOne('/api/auth/refresh');

    await switchUser();
    request.flush(TOKEN_PAIR);

    expect(await rotation).toBe(false);
    expect(auth.accessToken).toBeNull();
    expect(auth.refreshToken).toBeNull();
    // Stored for the account it belongs to, so that session stays resumable.
    expect(sessions.get('', 1)?.refreshToken).toBe('refresh-2');
  });

  it('installs the rotated pair when the session is still the same', async () => {
    const rotation = auth.refreshAccessToken();
    await settle();
    http.expectOne('/api/auth/refresh').flush(TOKEN_PAIR);

    expect(await rotation).toBe(true);
    expect(auth.accessToken).toBe('access-2');
    expect(sessions.get('', 1)?.refreshToken).toBe('refresh-2');
  });

  it('leaves the session stored and resumable after a user switch', async () => {
    await switchUser();

    expect(auth.user()).toBeNull();
    expect(sessions.active()).toBeNull();
    expect(sessions.get('', 1)?.refreshToken).toBe('refresh-1');
  });

  it('forgets a session the server refuses', async () => {
    const rotation = auth.refreshAccessToken();
    await settle();
    http
      .expectOne('/api/auth/refresh')
      .flush({ message: 'Invalid refresh token' }, { status: 401, statusText: '' });

    expect(await rotation).toBe(false);
    expect(sessions.get('', 1)).toBeNull();
  });
});
