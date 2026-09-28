import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { NEVER } from 'rxjs';
import { AuthService, type User } from './auth.service';
import { ServerConfigService } from './server-config.service';
import { ServerCacheService } from './server-cache.service';
import { SessionStoreService } from './session-store.service';

describe('AuthService: server features are live-only', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('hasServerFeature stays false for a stored user carrying a stray features field', () => {
    // A pre-fix persisted blob (or a downgraded server's old response) could
    // still carry `features` on disk; it must never be trusted over a live /me.
    const staleUser = {
      id: 1,
      username: 'a',
      features: ['deviceProfileExtensions'],
    } as unknown as User;
    TestBed.configureTestingModule({
      providers: [
        AuthService,
        { provide: HttpClient, useValue: { get: () => NEVER, post: () => NEVER } },
        { provide: Router, useValue: {} },
        { provide: ServerConfigService, useValue: { serverUrl: () => 'https://s', isNative: false } },
        { provide: ServerCacheService, useValue: {} },
        {
          provide: SessionStoreService,
          useValue: {
            active: () => ({
              serverUrl: 'https://s',
              user: staleUser,
              accessToken: 'a',
              refreshToken: 'r',
              refreshExpiresAt: null,
              lastUsedAt: Date.now(),
            }),
          },
        },
      ],
    });
    const service = TestBed.inject(AuthService);
    // The stored snapshot renders instantly; /auth/me (stubbed as NEVER) never answers.
    service.ensureAuthenticated().subscribe();
    expect(service.hasServerFeature('deviceProfileExtensions')).toBe(false);
  });
});
