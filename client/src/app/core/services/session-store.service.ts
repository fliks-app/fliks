import { Injectable, computed, signal } from '@angular/core';
import type { User } from './auth.service';
import {
  readPreference,
  removePreference,
  writePreference,
} from '../utils/preference-storage';

const STORE_LOCK = 'fliks-session-store';
const SESSIONS_STORAGE_KEY = 'fliks_sessions';
export const ACTIVE_SESSION_STORAGE_KEY = 'fliks_active_session';

/** Sessions kept per device, least recently used dropped first. Low on
 *  purpose: each one is a long-lived credential on a possibly shared device. */
export const MAX_SESSIONS = 6;

/** Credentials of one account on one server, kept so the user can return without re-authenticating; `user` (last known profile)
 *  makes a session displayable before any request succeeds. */
export interface StoredSession {
  serverUrl: string;
  user: User;
  accessToken: string | null;
  refreshToken: string;
  /** UNIX ms, or null when the server didn't report an expiry. */
  refreshExpiresAt: number | null;
  lastUsedAt: number;
  /** Rotation counter, bumped on each stored pair; absent on sessions saved before it existed. */
  tokenVersion?: number;
}

export interface SessionTokens {
  accessToken: string | null;
  refreshToken: string;
  refreshExpiresAt: number | null;
}

export function sessionKey(serverUrl: string, userId: number): string {
  return `${serverUrl}::${userId}`;
}

function isSame(session: StoredSession, serverUrl: string, userId: number): boolean {
  return session.serverUrl === serverUrl && session.user.id === userId;
}

/** The same account on two servers is two sessions; the same account twice on
 *  one server is one, so an upsert replaces rather than appends. */
export function upsertSession(
  list: StoredSession[],
  session: StoredSession,
): StoredSession[] {
  return [
    session,
    ...list.filter((s) => !isSame(s, session.serverUrl, session.user.id)),
  ];
}

export function removeSession(
  list: StoredSession[],
  serverUrl: string,
  userId: number,
): StoredSession[] {
  return list.filter((s) => !isSame(s, serverUrl, userId));
}

export function findSession(
  list: StoredSession[],
  serverUrl: string,
  userId: number,
): StoredSession | null {
  return list.find((s) => isSame(s, serverUrl, userId)) ?? null;
}

/** Drop what can no longer be resumed (no refresh token, no profile, or an
 *  expired token) and keep the most recently used within {@link MAX_SESSIONS}. */
export function pruneSessions(
  list: StoredSession[],
  now = Date.now(),
  max = MAX_SESSIONS,
): StoredSession[] {
  return list
    .filter(
      (s) =>
        !!s?.refreshToken &&
        !!s.user?.id &&
        (s.refreshExpiresAt === null || s.refreshExpiresAt > now),
    )
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, max);
}

function parseSessions(raw: string | null): StoredSession[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as StoredSession[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Index of the accounts this device can sign into without a password, keyed by (server, user); persistence only (token handling is {@link AuthService}'s).
 *  A leaf: injects nothing, lookups take the server URL. */
@Injectable({ providedIn: 'root' })
export class SessionStoreService {
  private readonly _sessions = signal<StoredSession[]>([]);
  private readonly _activeKey = signal<string | null>(null);

  readonly sessions = this._sessions.asReadonly();

  private queue: Promise<unknown> = Promise.resolve();

  /** Session the app is currently signed into, or null when signed out. */
  readonly active = computed(() => {
    const key = this._activeKey();
    if (!key) return null;
    return (
      this._sessions().find((s) => sessionKey(s.serverUrl, s.user.id) === key) ??
      null
    );
  });

  /** Sessions grouped by server, newest first. */
  private readonly byServer = computed(() => {
    const map = new Map<string, StoredSession[]>();
    for (const session of this._sessions()) {
      const bucket = map.get(session.serverUrl);
      if (bucket) bucket.push(session);
      else map.set(session.serverUrl, [session]);
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    }
    return map;
  });

  load(): Promise<void> {
    return this.serial(() => this.loadNow());
  }

  private async loadNow(): Promise<void> {
    const [rawSessions, activeKey] = await Promise.all([
      readPreference(SESSIONS_STORAGE_KEY),
      readPreference(ACTIVE_SESSION_STORAGE_KEY),
    ]);
    const stored = parseSessions(rawSessions);
    const pruned = pruneSessions(stored);
    this._sessions.set(pruned);
    this._activeKey.set(
      activeKey && pruned.some((s) => sessionKey(s.serverUrl, s.user.id) === activeKey)
        ? activeKey
        : null,
    );
    if (pruned.length !== stored.length) await this.persist();
  }

  get(serverUrl: string, userId: number): StoredSession | null {
    return findSession(this._sessions(), serverUrl, userId);
  }

  forServer(serverUrl: string): StoredSession[] {
    return this.byServer().get(serverUrl) ?? [];
  }

  /** Resolves `false` when the write failed. */
  async save(session: StoredSession): Promise<boolean> {
    return this.mutate((list) => {
      const existing = findSession(list, session.serverUrl, session.user.id);
      const tokenVersion = (existing?.tokenVersion ?? 0) + 1;
      return upsertSession(list, { ...session, tokenVersion });
    });
  }

  async setActive(serverUrl: string, userId: number): Promise<void> {
    this._activeKey.set(sessionKey(serverUrl, userId));
    await this.mutate((list) => {
      const existing = findSession(list, serverUrl, userId);
      return existing
        ? upsertSession(list, { ...existing, lastUsedAt: Date.now() })
        : list;
    });
  }

  async clearActive(): Promise<void> {
    this._activeKey.set(null);
    await this.serial(() => removePreference(ACTIVE_SESSION_STORAGE_KEY));
  }

  async remove(serverUrl: string, userId: number): Promise<void> {
    if (this._activeKey() === sessionKey(serverUrl, userId)) this._activeKey.set(null);
    await this.mutate((list) => removeSession(list, serverUrl, userId));
  }

  /** Re-key a server's sessions after its address changed; the newest wins on a clash. */
  async moveServer(from: string, to: string): Promise<void> {
    if (from === to) return;
    const key = this._activeKey();
    if (key?.startsWith(`${from}::`)) this._activeKey.set(to + key.slice(from.length));
    await this.mutate((list) => {
      const moved = list
        .map((s) => (s.serverUrl === from ? { ...s, serverUrl: to } : s))
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
      return moved.filter((s, i) => moved.findIndex((o) => isSame(o, s.serverUrl, s.user.id)) === i);
    });
  }

  /** Persist a rotation. Awaited before anything else touches the new pair:
   *  re-presenting a rotated token costs every session of the account. */
  async updateTokens(
    serverUrl: string,
    userId: number,
    tokens: SessionTokens,
  ): Promise<void> {
    await this.mutate((list) => {
      const existing = findSession(list, serverUrl, userId);
      if (!existing) return list;
      return upsertSession(list, {
        ...existing,
        ...tokens,
        lastUsedAt: Date.now(),
        tokenVersion: (existing.tokenVersion ?? 0) + 1,
      });
    });
  }

  async updateUser(serverUrl: string, userId: number, user: User): Promise<void> {
    await this.mutate((list) => {
      const existing = findSession(list, serverUrl, userId);
      return existing ? upsertSession(list, { ...existing, user }) : list;
    });
  }

  /** Read-modify-write against storage, serialised in this instance and across tabs:
   *  an interleaved writer would otherwise put back a stale refresh token. */
  private mutate(apply: (list: StoredSession[]) => StoredSession[]): Promise<boolean> {
    return this.serial(async () => {
      const persisted = parseSessions(await readPreference(SESSIONS_STORAGE_KEY));
      this._sessions.set(pruneSessions(apply(persisted)));
      return this.persist();
    });
  }

  /** Never nest: a serial section awaiting another one would deadlock. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    const run = () => (locks ? locks.request(STORE_LOCK, fn) : fn());
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async persist(): Promise<boolean> {
    const key = this._activeKey();
    const [stored] = await Promise.all([
      writePreference(SESSIONS_STORAGE_KEY, JSON.stringify(this._sessions())),
      key
        ? writePreference(ACTIVE_SESSION_STORAGE_KEY, key)
        : removePreference(ACTIVE_SESSION_STORAGE_KEY),
    ]);
    return stored;
  }
}
