import { Injectable, computed, signal } from '@angular/core';
import type { User } from './auth.service';
import {
  readPreference,
  removePreference,
  writePreference,
} from '../utils/preference-storage';

const SESSIONS_STORAGE_KEY = 'fliks_sessions';
export const ACTIVE_SESSION_STORAGE_KEY = 'fliks_active_session';

/** Sessions kept per device, least recently used dropped first. Low on
 *  purpose: each one is a long-lived credential on a possibly shared device. */
export const MAX_SESSIONS = 6;

/**
 * Credentials of one account on one server, kept so the user can leave it and
 * come back without re-authenticating. `user` is the last known profile: it
 * drives the picker and the offline boot, so a session is displayable before
 * any request succeeds.
 */
export interface StoredSession {
  serverUrl: string;
  user: User;
  accessToken: string | null;
  refreshToken: string;
  /** UNIX ms, or null when the server didn't report an expiry. */
  refreshExpiresAt: number | null;
  lastUsedAt: number;
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

/**
 * Index of the accounts this device can sign into without a password, keyed by
 * (server, user). Persistence only — rotating and validating tokens is
 * {@link AuthService}'s job. A leaf: it injects nothing, and every lookup takes
 * the server URL as an argument.
 */
@Injectable({ providedIn: 'root' })
export class SessionStoreService {
  private readonly _sessions = signal<StoredSession[]>([]);
  private readonly _activeKey = signal<string | null>(null);

  readonly sessions = this._sessions.asReadonly();

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

  async load(): Promise<void> {
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
    return this.mutate((list) => upsertSession(list, session));
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
    await removePreference(ACTIVE_SESSION_STORAGE_KEY);
  }

  async remove(serverUrl: string, userId: number): Promise<void> {
    if (this._activeKey() === sessionKey(serverUrl, userId)) this._activeKey.set(null);
    await this.mutate((list) => removeSession(list, serverUrl, userId));
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
      return upsertSession(list, { ...existing, ...tokens, lastUsedAt: Date.now() });
    });
  }

  async updateUser(serverUrl: string, userId: number, user: User): Promise<void> {
    await this.mutate((list) => {
      const existing = findSession(list, serverUrl, userId);
      return existing ? upsertSession(list, { ...existing, user }) : list;
    });
  }

  /** Read-modify-write against storage, not the in-memory list: two writers
   *  would otherwise each persist their own snapshot and revert the other. */
  private async mutate(
    apply: (list: StoredSession[]) => StoredSession[],
  ): Promise<boolean> {
    const persisted = parseSessions(await readPreference(SESSIONS_STORAGE_KEY));
    const next = pruneSessions(apply(persisted));
    this._sessions.set(next);
    return this.persist();
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
