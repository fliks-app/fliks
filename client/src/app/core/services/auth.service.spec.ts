import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { NEVER, of, throwError } from 'rxjs';
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

describe('AuthService.mintEventTicket', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setup(post: (...args: unknown[]) => unknown) {
    TestBed.configureTestingModule({
      providers: [
        AuthService,
        { provide: HttpClient, useValue: { get: () => NEVER, post } },
        { provide: Router, useValue: {} },
        { provide: ServerConfigService, useValue: { serverUrl: () => 'https://s', isNative: false } },
        { provide: ServerCacheService, useValue: {} },
        { provide: SessionStoreService, useValue: { active: () => null } },
      ],
    });
    return TestBed.inject(AuthService);
  }

  it('returns the ticket the server minted', async () => {
    const post = vi.fn((..._args: unknown[]) => of({ ticket: 'tk', expiresIn: 30 }));
    expect(await setup(post).mintEventTicket()).toBe('tk');
    expect(post.mock.calls[0]![0]).toBe('/api/system/events/ticket');
  });

  it('returns null when the server has no ticket route', async () => {
    expect(await setup(() => throwError(() => new Error('404'))).mintEventTicket()).toBeNull();
  });
});

describe('AuthService.ensureStreamToken', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setup(post: () => unknown) {
    TestBed.configureTestingModule({
      providers: [
        AuthService,
        { provide: HttpClient, useValue: { get: () => NEVER, post } },
        { provide: Router, useValue: {} },
        { provide: ServerConfigService, useValue: { serverUrl: () => 'https://s', isNative: false } },
        { provide: ServerCacheService, useValue: {} },
        { provide: SessionStoreService, useValue: { active: () => null } },
      ],
    });
    return TestBed.inject(AuthService);
  }

  it('retries once after a failed mint', async () => {
    const post = vi
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('blip')))
      .mockReturnValueOnce(of({ streamToken: 'st', expiresAt: Date.now() + 3 * 3600_000 }));
    const service = setup(post);

    expect(await service.ensureStreamToken()).toBe('st');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('returns null once the retry fails too', async () => {
    const post = vi.fn(() => throwError(() => new Error('down')));
    const service = setup(post);

    expect(await service.ensureStreamToken()).toBeNull();
    expect(post).toHaveBeenCalledTimes(2);
  });
});
