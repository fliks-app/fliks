import type { User } from './auth.service';
import {
  MAX_SESSIONS,
  SessionStoreService,
  type StoredSession,
  findSession,
  pruneSessions,
  removeSession,
  upsertSession,
} from './session-store.service';

const user = (id: number): User =>
  ({ id, username: `user${id}`, avatar: null }) as User;

const session = (
  serverUrl: string,
  userId: number,
  overrides: Partial<StoredSession> = {},
): StoredSession => ({
  serverUrl,
  user: user(userId),
  accessToken: 'access',
  refreshToken: `refresh-${serverUrl}-${userId}`,
  refreshExpiresAt: null,
  lastUsedAt: 1000,
  ...overrides,
});

const ids = (list: StoredSession[]) => list.map((s) => s.user.id);

describe('upsertSession', () => {
  it('replaces the session of the same (server, user) instead of duplicating it', () => {
    const list = [session('https://a', 1), session('https://a', 2)];
    const next = upsertSession(list, session('https://a', 1, { refreshToken: 'fresh' }));
    expect(next).toHaveLength(2);
    expect(findSession(next, 'https://a', 1)?.refreshToken).toBe('fresh');
  });

  it('keeps the same account on two servers as two sessions', () => {
    const next = upsertSession([session('https://a', 1)], session('https://b', 1));
    expect(next).toHaveLength(2);
  });
});

describe('removeSession', () => {
  it('drops only the targeted (server, user)', () => {
    const list = [
      session('https://a', 1),
      session('https://a', 2),
      session('https://b', 1),
    ];
    const next = removeSession(list, 'https://a', 1);
    expect(next.map((s) => `${s.serverUrl}#${s.user.id}`)).toEqual([
      'https://a#2',
      'https://b#1',
    ]);
  });
});

describe('pruneSessions', () => {
  it('drops sessions whose refresh token has expired', () => {
    const list = [
      session('https://a', 1, { refreshExpiresAt: 500 }),
      session('https://a', 2, { refreshExpiresAt: 2000 }),
      session('https://a', 3, { refreshExpiresAt: null }),
    ];
    expect(ids(pruneSessions(list, 1000))).toEqual([2, 3]);
  });

  it('drops entries with no refresh token — they cannot be resumed', () => {
    const list = [session('https://a', 1, { refreshToken: '' }), session('https://a', 2)];
    expect(ids(pruneSessions(list, 0))).toEqual([2]);
  });

  it('caps the list at MAX_SESSIONS, keeping the most recently used', () => {
    const list = Array.from({ length: MAX_SESSIONS + 5 }, (_, i) =>
      session('https://a', i + 1, { lastUsedAt: i }),
    );
    const next = pruneSessions(list, 0);
    expect(next).toHaveLength(MAX_SESSIONS);
    expect(next[0].lastUsedAt).toBe(MAX_SESSIONS + 4);
  });
});

describe('SessionStoreService persistence', () => {
  const store = () => new SessionStoreService();

  beforeEach(() => localStorage.clear());

  it('round-trips sessions and the active pointer through storage', async () => {
    const a = store();
    await a.save(session('https://a', 1));
    await a.save(session('https://a', 2));
    await a.setActive('https://a', 2);

    const b = store();
    await b.load();
    expect(ids(b.sessions()).sort()).toEqual([1, 2]);
    expect(b.active()?.user.id).toBe(2);
  });

  it('forgets an expired session on load, and its active pointer with it', async () => {
    const a = store();
    await a.save(session('https://a', 1, { refreshExpiresAt: Date.now() - 1000 }));
    await a.setActive('https://a', 1);

    const b = store();
    await b.load();
    expect(b.sessions()).toHaveLength(0);
    expect(b.active()).toBeNull();
  });

  it('patches one session without reverting another writer rotation', async () => {
    const a = store();
    await a.save(session('https://a', 1, { refreshToken: 'r1' }));
    await a.save(session('https://a', 2, { refreshToken: 'r2' }));

    // Another writer rotates session 2 while `a` still holds the old array.
    const b = store();
    await b.load();
    await b.updateTokens('https://a', 2, {
      accessToken: 'fresh',
      refreshToken: 'r2-rotated',
      refreshExpiresAt: null,
    });

    await a.updateTokens('https://a', 1, {
      accessToken: 'fresh',
      refreshToken: 'r1-rotated',
      refreshExpiresAt: null,
    });

    const c = store();
    await c.load();
    expect(c.get('https://a', 1)?.refreshToken).toBe('r1-rotated');
    expect(c.get('https://a', 2)?.refreshToken).toBe('r2-rotated');
  });

  it('removing the active session clears the pointer', async () => {
    const a = store();
    await a.save(session('https://a', 1));
    await a.setActive('https://a', 1);
    await a.remove('https://a', 1);
    expect(a.active()).toBeNull();

    const b = store();
    await b.load();
    expect(b.active()).toBeNull();
    expect(b.sessions()).toHaveLength(0);
  });

  it('groups resumable sessions by server, newest first', async () => {
    const a = store();
    await a.save(session('https://a', 1, { lastUsedAt: 10 }));
    await a.save(session('https://a', 2, { lastUsedAt: 50 }));
    await a.save(session('https://b', 3, { lastUsedAt: 99 }));
    expect(ids(a.forServer('https://a'))).toEqual([2, 1]);
    expect(ids(a.forServer('https://b'))).toEqual([3]);
    expect(a.forServer('https://c')).toEqual([]);
  });
});
