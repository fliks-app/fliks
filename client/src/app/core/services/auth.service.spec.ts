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

  function setup(post: (...args: any[]) => unknown) {
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

    expect(await service.ensureStreamToken(7)).toBe('st');
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledWith('/api/auth/stream-token', { mediaFileId: 7 });
  });

  it('keeps one token per file and falls back to the access token for another', async () => {
    const post = vi.fn((_url: string, body: { mediaFileId: number }) =>
      of({ streamToken: `st${body.mediaFileId}`, expiresAt: Date.now() + 3 * 3600_000 }),
    );
    const service = setup(post);

    await service.ensureStreamToken(1);
    await service.ensureStreamToken(2);
    await service.ensureStreamToken(1);
    expect(post).toHaveBeenCalledTimes(2);
    expect(service.playbackTokenFor(1)).toBe('st1');
    expect(service.playbackTokenFor(2)).toBe('st2');
    expect(service.playbackTokenFor(3)).toBe(service.accessToken);
  });

  it('remints a token with less than 30 minutes left', async () => {
    const post = vi.fn(() => of({ streamToken: 'st', expiresAt: Date.now() + 10 * 60_000 }));
    const service = setup(post);

    await service.ensureStreamToken(1);
    await service.ensureStreamToken(1);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('returns null once the retry fails too', async () => {
    const post = vi.fn(() => throwError(() => new Error('down')));
    const service = setup(post);

    expect(await service.ensureStreamToken(7)).toBeNull();
    expect(post).toHaveBeenCalledTimes(2);
  });
});

describe('AuthService.hasPermission', () => {
  afterEach(() => TestBed.resetTestingModule());

  function as(user: Partial<User>) {
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
            active: () => ({ serverUrl: 'https://s', user: { id: 1, username: 'a', ...user }, accessToken: 'a', refreshToken: 'r', refreshExpiresAt: null, lastUsedAt: Date.now() }),
          },
        },
      ],
    });
    const service = TestBed.inject(AuthService);
    service.ensureAuthenticated().subscribe();
    return service;
  }

  it('honours implications', () => {
    const s = as({ permissions: ['parties.manage'] });
    expect(s.hasPermission('parties.create')).toBe(true);
    expect(s.hasPermission('media.read')).toBe(false);
  });

  it('grants an admin everything', () => {
    expect(as({ isAdmin: true }).hasPermission('parties.create')).toBe(true);
  });
});
