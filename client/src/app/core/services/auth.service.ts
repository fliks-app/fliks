import { Injectable, signal, computed, inject, untracked } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, catchError, firstValueFrom, map, of, tap } from 'rxjs';
import { ServerConfigService } from './server-config.service';
import { ServerCacheService } from './server-cache.service';
import {
  ACTIVE_SESSION_STORAGE_KEY,
  SessionStoreService,
  sessionKey,
  type SessionTokens,
} from './session-store.service';
import { IS_STANDALONE_BUNDLE, restartApp } from '../utils/standalone-bundle';

export interface User {
  id: number;
  username: string;
  email: string;
  role: string | null;
  roleId: number | null;
  isAdmin: boolean;
  permissions: string[];
  avatar: string | null;
  /** Admin-set: when true the route guard pins the user on /forced-password-change. */
  requirePasswordChange: boolean;
  /** Per-user library display order (library ids, first to last). */
  libraryOrder: number[];
  /** Per-user libraries hidden from the home page and sidebar. */
  hiddenLibraryIds: number[];
  /** Social profile discoverability. */
  profileVisibility: ProfileVisibility;
  /** Expose derived top-genres on the public profile. */
  shareTastes: boolean;
  /** Expose personal recommendations on the public profile. */
  shareRecommendations: boolean;
  /** Expose recently-watched on the public profile. */
  shareWatchHistory: boolean;
  /** Expose liked content on the public profile. */
  shareLikes: boolean;
  /** Expose activity statistics on the public profile. */
  shareStats: boolean;
  /** Opt out of the whole social layer (undiscoverable + can't use sharing). */
  shareDisabled: boolean;
}

/** Public = instant follow + shared content; private = follow on approval. */
export type ProfileVisibility = 'public' | 'private';

interface LoginResponse {
  user: User;
  accessToken?: string;
  refreshToken?: string;
  /** UNIX seconds. */
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
}

interface TokenPairResponse {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
}

/** Lightweight user fields exposed by GET /auth/users-public for the picker. */
export interface PublicUserSummary {
  id: number;
  username: string;
  avatar: string | null;
}

export type PairingStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface PairingStatusResponse {
  status: PairingStatus;
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
}

export interface PendingRequest {
  pairingId: string;
  deviceId: string;
  /** Display label, already composed by the requester ("Application macOS 26"). */
  deviceName: string;
  /** Real host OS name+version ("macOS 26"), resolved natively by the requester. */
  systemName?: string;
  requestedAt: string;
  expiresAt: string;
}

/** Why a resume ended: signed in, credentials refused, or server unreachable. */
export type ResumeOutcome = 'resumed' | 'expired' | 'unreachable';

/** The backend reports token expiries as UNIX seconds; the store keeps ms, and
 *  null for "unknown" — anything non-positive would read as expired in 1970. */
function secondsToMs(seconds: number | undefined): number | null {
  return typeof seconds === 'number' && seconds > 0 ? seconds * 1000 : null;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly serverCache = inject(ServerCacheService);
  private readonly sessions = inject(SessionStoreService);

  /** Web authenticates with one origin-wide cookie, read by the backend BEFORE
   *  the Bearer header: only the active session is signed in at a time. */
  private readonly cookieAuth = !IS_STANDALONE_BUNDLE;

  private readonly _user = signal<User | null>(null);
  private _accessToken: string | null = null;
  private _refreshToken: string | null = null;
  /** In-flight refresh request shared across concurrent 401s so we only
   *  rotate once even when 10 parallel calls all fail at the same time. */
  private _refreshInFlight: Promise<boolean> | null = null;
  /** Long-lived stream JWT cached for the player + URL builders. See
   *  ensureStreamToken() for the lifecycle. */
  private _streamToken = signal<string | null>(null);
  private _streamTokenExpiresAt = 0;
  private _streamTokenInFlight: Promise<string | null> | null = null;
  private readonly _sessionEpoch = signal(0);

  constructor() {
    // Another tab switched account, so the cookie under this one changed too:
    // its requests now authenticate as someone else. Restart to match.
    if (typeof window !== 'undefined' && this.cookieAuth) {
      window.addEventListener('storage', (e) => {
        if (e.key !== ACTIVE_SESSION_STORAGE_KEY) return;
        const user = this._user();
        if (!user) return;
        if (e.newValue !== sessionKey(this.serverConfig.serverUrl(), user.id)) {
          restartApp();
        }
      });
    }
  }

  get accessToken(): string | null {
    return this._accessToken;
  }

  get refreshToken(): string | null {
    return this._refreshToken;
  }

  /** Read-only stream token signal. Cached value — call
   *  ensureStreamToken() before starting a playback session to make
   *  sure it isn't near expiry. */
  readonly streamToken = this._streamToken.asReadonly();

  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => !!this._user());
  /** Incremented whenever the signed-in session changes (login, resume, switch,
   *  logout). Services holding session-bound state — the SSE stream, download
   *  recovery, the response cache — watch it to rebind. */
  readonly sessionEpoch = this._sessionEpoch.asReadonly();
  /** True when the user opted out of the social/sharing layer — social UI
   *  surfaces (follow, recommend, playlist collaborators/save, people search)
   *  are hidden and the backend rejects the actions. */
  readonly sharingDisabled = computed(() => !!this._user()?.shareDisabled);

  /** Accounts that can be signed into on the active server without a password,
   *  newest first. */
  readonly resumableSessions = computed(() =>
    this.sessions.forServer(this.serverConfig.serverUrl()),
  );

  /** Servers with at least one resumable session, for the server list. */
  readonly serversWithSession = computed<ReadonlySet<string>>(
    () => new Set(this.sessions.sessions().map((s) => s.serverUrl)),
  );

  /** Check if the current user has a specific permission. */
  hasPermission(perm: string): boolean {
    const u = this._user();
    if (u?.isAdmin) return true;
    return u?.permissions?.includes(perm) ?? false;
  }

  /** Convenience: true if the user has settings.access permission. */
  readonly canAccessSettings = computed(() => {
    const u = this._user();
    return u?.isAdmin || u?.permissions?.includes('settings.access') || false;
  });

  /** Convenience: true if the user can manage users. */
  readonly canManageUsers = computed(() => {
    const u = this._user();
    return u?.isAdmin || u?.permissions?.includes('users.manage') || false;
  });

  /**
   * Juste avant le chargement Cast : token dédié (court) + base URL côté serveur.
   */
  async getCastInfo(): Promise<{ token: string; streamBaseUrl: string }> {
    return firstValueFrom(
      this.http.post<{ token: string; streamBaseUrl: string }>(
        '/api/auth/cast-info',
        {},
      ),
    );
  }

  async login(username: string, password: string): Promise<LoginResponse> {
    // Wipe any cached data from a previous session BEFORE the auth round-trip,
    // so the new login starts on a clean slate.
    await this.serverCache.clearAll();
    const res = await firstValueFrom(
      this.http.post<LoginResponse>('/api/auth/login', { username, password }),
    );
    await this.startSession(res.user, {
      accessToken: res.accessToken ?? null,
      refreshToken: res.refreshToken ?? '',
      refreshExpiresAt: secondsToMs(res.refreshTokenExpiresAt),
    });
    // Fire-and-forget — bumps the active server in the known-servers list
    // so it surfaces first in /setup next time. Awaiting here could block
    // the login spinner if the Preferences write stalled.
    const activeUrl = this.serverConfig.serverUrl();
    if (activeUrl) {
      void this.serverConfig.addOrTouchKnownServer(activeUrl, {
        username: res.user.username,
      });
    }
    return res;
  }

  /** Pre-login user picker — see PublicUserSummary. */
  listUsersPublic(): Promise<PublicUserSummary[]> {
    return firstValueFrom(this.http.get<PublicUserSummary[]>('/api/auth/users-public'));
  }

  // ── Pairing (quick connect) ──

  pairingRequest(
    userId: number,
    deviceId: string,
    deviceName: string,
    systemName?: string,
  ): Promise<{ pairingId: string; expiresIn: number }> {
    return firstValueFrom(
      this.http.post<{ pairingId: string; expiresIn: number }>(
        '/api/auth/pairing/request',
        { userId, deviceName, systemName },
        { headers: { 'X-Device-Id': deviceId } },
      ),
    );
  }

  pairingStatus(pairingId: string, deviceId: string): Promise<PairingStatusResponse> {
    return firstValueFrom(
      this.http.get<PairingStatusResponse>('/api/auth/pairing/status', {
        params: { pairingId },
        headers: { 'X-Device-Id': deviceId },
      }),
    );
  }

  pairingPending(): Promise<PendingRequest[]> {
    return firstValueFrom(this.http.get<PendingRequest[]>('/api/auth/pairing/pending'));
  }

  pairingApprove(pairingId: string): Promise<void> {
    return firstValueFrom(
      this.http.post<void>(`/api/auth/pairing/${pairingId}/approve`, {}),
    );
  }

  pairingDeny(pairingId: string): Promise<void> {
    return firstValueFrom(
      this.http.post<void>(`/api/auth/pairing/${pairingId}/deny`, {}),
    );
  }

  /**
   * Adopt a token issued through the pairing flow. Mirrors the post-success
   * branch of `login()` so the storage / `/auth/me` hydrate path is identical.
   */
  async loginWithToken(
    accessToken: string,
    refreshToken?: string,
    refreshTokenExpiresAt?: number,
  ): Promise<void> {
    await this.serverCache.clearAll();
    // The interceptor reads these for the /auth/me below; startSession then
    // makes them the stored session.
    this.adoptSessionTokens(accessToken, refreshToken ?? null);
    const user = await firstValueFrom(this.http.get<User>('/api/auth/me'));
    await this.startSession(user, {
      accessToken,
      refreshToken: refreshToken ?? '',
      refreshExpiresAt: secondsToMs(refreshTokenExpiresAt),
    });
    const activeUrl = this.serverConfig.serverUrl();
    if (activeUrl) {
      await this.serverConfig.addOrTouchKnownServer(activeUrl, {
        username: user.username,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Switching account / server without logging out
  // ---------------------------------------------------------------------------

  /**
   * Sign back into a stored session — no password, no quick-connect. The stored
   * tokens are adopted as-is and the interceptor rotates them lazily on a 401:
   * a rotation whose new pair never reaches storage reads as theft on the
   * backend, which revokes every session of the account. Web rotates up-front
   * anyway — its cookie still belongs to the account being left.
   */
  async resumeSession(userId: number): Promise<ResumeOutcome> {
    const serverUrl = this.serverConfig.serverUrl();
    const stored = this.sessions.get(serverUrl, userId);
    if (!stored) return 'expired';

    this.clearInMemorySession();
    await this.serverCache.clearAll();
    await this.sessions.setActive(serverUrl, userId);
    this.adoptSessionTokens(stored.accessToken, stored.refreshToken);
    // Instant: the stored profile renders the app while /auth/me confirms it.
    this._user.set(stored.user);
    this._sessionEpoch.update((n) => n + 1);

    if (this.cookieAuth && !(await this.refreshAccessToken())) {
      // A rejected session is already gone; a network failure keeps it.
      const alive = !!this.sessions.get(serverUrl, userId);
      this.clearInMemorySession();
      return alive ? 'unreachable' : 'expired';
    }

    try {
      const user = await firstValueFrom(this.http.get<User>('/api/auth/me'));
      // The server may answer as somebody else — a cookie that outlived its
      // account, a token that never belonged to this one.
      if (user.id !== userId) {
        await this.sessions.remove(serverUrl, userId);
        this.clearInMemorySession();
        return 'expired';
      }
      this._user.set(user);
      await this.sessions.updateUser(serverUrl, userId, user);
      return 'resumed';
    } catch (err) {
      const status = err instanceof HttpErrorResponse ? err.status : 0;
      if (status === 401 || status === 403) {
        await this.sessions.remove(serverUrl, userId);
        this.clearInMemorySession();
        return 'expired';
      }
      // Offline or server down: keep the session and stay on the stored
      // profile, so downloaded media remains reachable.
      return 'resumed';
    }
  }

  /** Leave the current account without logging it out: its session stays
   *  stored, and the picker offers it back in one tap. */
  async beginUserSwitch(): Promise<void> {
    if (this.cookieAuth) {
      // An empty body clears the cookie and revokes nothing: still resumable.
      try {
        await firstValueFrom(this.http.post('/api/auth/logout', {}));
      } catch {
        /* best effort — the cookie expires on its own */
      }
    }
    await this.sessions.clearActive();
    this.clearInMemorySession();
    await this.serverCache.clearAll();
  }

  /**
   * Point the app at another server, keeping every stored session, and resume
   * that server's newest one. The app restarts: URLs resolved against the
   * previous origin live on in DOM bindings, the player, cast and SSE.
   */
  async switchToServer(url: string): Promise<void> {
    await this.serverConfig.save(url);
    const canonical = this.serverConfig.serverUrl();
    await this.serverConfig.addOrTouchKnownServer(canonical);
    const resumable = this.sessions.forServer(canonical)[0] ?? null;
    if (resumable) {
      await this.sessions.setActive(resumable.serverUrl, resumable.user.id);
    } else {
      await this.sessions.clearActive();
    }
    this.clearInMemorySession();
    await this.serverCache.clearAll();
    restartApp();
  }

  /**
   * Refresh the session by rotating the stored refresh token. Resolves `true`
   * when usable credentials are in place afterwards (a fresh access token was
   * obtained, or another tab had already rotated and we adopted it), `false`
   * when refresh isn't possible — no stored token, or the server rejected ours.
   *
   * The boolean is a "retry the original request now?" signal: the fresh access
   * token itself lands on {@link accessToken} / the session cookie as a side
   * effect, which is what callers attach.
   *
   * Single-flight: parallel callers (e.g. 10 requests all 401-ing at once)
   * share one in-flight promise so the server only rotates once. A server
   * rejection is terminal — the session is dropped and the user is sent back
   * to /select-user. Network/5xx failures keep the tokens so a flaky
   * connection doesn't log the user out.
   */
  async refreshAccessToken(): Promise<boolean> {
    if (this._refreshInFlight) return this._refreshInFlight;
    if (!this._refreshToken) return false;
    this._refreshInFlight = this.runRefresh().finally(() => {
      this._refreshInFlight = null;
    });
    return this._refreshInFlight;
  }

  /**
   * Cross-tab refresh coordination. Rotation invalidates the presented token,
   * so two browser tabs racing to refresh would have the lagging one replay an
   * already-rotated token — which the server treats as theft and revokes EVERY
   * session. We serialise refreshes across tabs with the Web Locks API; the tab
   * that wins the lock rotates, the others then see the token already changed
   * and adopt it instead of replaying. Native/TV run a single webview, so they
   * just refresh in-process (the {@link _refreshInFlight} single-flight covers
   * the parallel-401 burst).
   */
  private async runRefresh(): Promise<boolean> {
    const tokenAtStart = this._refreshToken;
    const lockMgr =
      typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (this.cookieAuth && lockMgr) {
      return lockMgr.request('fliks-token-refresh', () =>
        this.rotateOrAdopt(tokenAtStart),
      );
    }
    return this.rotateOrAdopt(tokenAtStart);
  }

  /** Re-read the freshest stored token; if another tab rotated it while we
   *  waited for the lock, adopt it and skip the network call (that tab's
   *  /refresh already set a fresh access cookie) so we don't replay a revoked
   *  token. Otherwise perform the rotation ourselves. */
  private async rotateOrAdopt(tokenAtStart: string | null): Promise<boolean> {
    const stored = await this.readStoredRefreshToken();
    if (this.cookieAuth && stored && stored !== tokenAtStart) {
      this._refreshToken = stored;
      return true;
    }
    return this.doRefresh(stored ?? tokenAtStart);
  }

  private async doRefresh(refresh: string | null): Promise<boolean> {
    if (!refresh) return false;
    // Captured before the round-trip: the rotated pair belongs to THIS session,
    // and the user may switch account or server while we are in flight.
    const target = this.sessions.active();
    const epoch = untracked(this._sessionEpoch);
    if (target && target.serverUrl !== this.serverConfig.serverUrl()) {
      // Sending this token would hand one server's credential to another host.
      return false;
    }
    try {
      const res = await firstValueFrom(
        this.http.post<TokenPairResponse>('/api/auth/refresh', {
          refreshToken: refresh,
        }),
      );
      // Persisted first, with nothing awaited in between: the presented token
      // is already revoked server-side, so the new pair must not be lost.
      if (target) {
        await this.sessions.updateTokens(target.serverUrl, target.user.id, {
          accessToken: this.cookieAuth ? null : res.accessToken,
          refreshToken: res.refreshToken,
          refreshExpiresAt: secondsToMs(res.refreshTokenExpiresAt),
        });
      }
      // Another session took over meanwhile. The pair is stored for the account
      // it belongs to; installing it here would authenticate this screen as
      // that account.
      if (untracked(this._sessionEpoch) !== epoch) return false;
      this._accessToken = res.accessToken;
      this._refreshToken = res.refreshToken;
      return true;
    } catch (err) {
      const status = err instanceof HttpErrorResponse ? err.status : 0;
      // 4xx = server-side rejection (expired / revoked / theft-detection).
      // Anything else (0 = offline, 5xx = hiccup) is transient: keep the tokens
      // so a flaky connection doesn't log the user out.
      if (status < 400 || status >= 500) return false;
      if (untracked(this._sessionEpoch) !== epoch) {
        // The refused credentials belong to a session we have already left.
        if (target) await this.sessions.remove(target.serverUrl, target.user.id);
        return false;
      }
      // Another tab may have rotated meanwhile: then our token was merely
      // stale, not dead — adopt the new one and let the caller retry.
      const stored = await this.readStoredRefreshToken();
      if (this.cookieAuth && stored && stored !== refresh) {
        this._refreshToken = stored;
        return true;
      }
      await this.dropActiveSession();
      return false;
    }
  }

  /**
   * Ensure a fresh stream token is cached. Fetched on first call, then
   * re-used as long as it has > 30 min of life left — playback URLs are
   * baked at `engine.load()` time and can't be updated mid-stream, so
   * we want to start every session with a fresh token whose TTL safely
   * exceeds the longest plausible film.
   *
   * Single-flight: concurrent callers share the same fetch.
   */
  async ensureStreamToken(): Promise<string | null> {
    const minRemaining = 30 * 60 * 1000;
    if (
      this._streamToken() &&
      this._streamTokenExpiresAt - Date.now() > minRemaining
    ) {
      return this._streamToken();
    }
    if (this._streamTokenInFlight) return this._streamTokenInFlight;
    this._streamTokenInFlight = (async () => {
      try {
        const res = await firstValueFrom(
          this.http.post<{ streamToken: string; expiresAt: number }>(
            '/api/auth/stream-token',
            {},
          ),
        );
        this._streamToken.set(res.streamToken);
        this._streamTokenExpiresAt = res.expiresAt;
        return res.streamToken;
      } catch {
        return null;
      } finally {
        this._streamTokenInFlight = null;
      }
    })();
    return this._streamTokenInFlight;
  }

  register(username: string, password: string, email?: string) {
    return firstValueFrom(
      this.http.post<User>('/api/auth/register', { username, password, email }),
    );
  }

  /** Hydrate la session au démarrage depuis le stockage, puis /auth/me. */
  async hydrateFromServer(): Promise<void> {
    if (this._user()) return;
    const snapshot = this.loadPersistedSession();
    if (snapshot) this._user.set(snapshot);
    try {
      const user = await firstValueFrom(this.http.get<User>('/api/auth/me'));
      this._user.set(user);
      await this.rememberUser(user);
    } catch {
      // Offline or unreachable: keep the stored profile so the app opens on the
      // last known account (downloads stay reachable). Dead credentials are
      // handled by the interceptor, which drops the session when rotation fails.
    }
  }

  /**
   * Force a re-fetch of /auth/me even when a user is already cached. Used
   * after server-side state changes that affect fields the frontend reacts
   * to — currently the requirePasswordChange flag, cleared by the backend
   * when the user changes their own password.
   */
  async refreshUser(): Promise<void> {
    try {
      const user = await firstValueFrom(this.http.get<User>('/api/auth/me'));
      this._user.set(user);
      await this.rememberUser(user);
    } catch {
      // Keep the previous user — refresh is best-effort.
    }
  }

  /** Locally merge fields into the current user after a self-update, so signal
   *  consumers react without a round-trip to /auth/me. */
  patchUser(partial: Partial<User>): void {
    this._user.update((u) => (u ? { ...u, ...partial } : u));
    const user = this._user();
    if (user) void this.rememberUser(user);
  }

  /** Pour le garde de route : session stockée sinon cookie web. */
  ensureAuthenticated(): Observable<boolean> {
    if (this._user()) return of(true);

    // A stored session is enough to render: adopt its profile now and validate
    // in the background, so a cold (or offline) start doesn't block on network.
    const snapshot = this.loadPersistedSession();
    if (snapshot) {
      this._user.set(snapshot);
      this.validateSessionInBackground();
      return of(true);
    }

    return this.http.get<User>('/api/auth/me').pipe(
      tap((u) => {
        this._user.set(u);
        void this.rememberUser(u);
      }),
      map(() => true),
      catchError(() => {
        this._user.set(null);
        return of(false);
      }),
    );
  }

  /** Validate the adopted session. A rejection that survived the interceptor's
   *  rotation means the credentials are dead; network errors are ignored so the
   *  snapshot keeps the app usable offline. */
  private validateSessionInBackground(): void {
    this.http.get<User>('/api/auth/me').subscribe({
      next: (user) => {
        this._user.set(user);
        void this.rememberUser(user);
      },
      error: (err: unknown) => {
        const status = (err as { status?: number })?.status ?? 0;
        if (status === 401 || status === 403) void this.dropActiveSession();
      },
    });
  }

  async logout(): Promise<void> {
    const refresh = this._refreshToken;
    try {
      await firstValueFrom(
        this.http.post('/api/auth/logout', refresh ? { refreshToken: refresh } : {}),
      );
    } finally {
      await this.dropActiveSession();
    }
  }

  // ---------------------------------------------------------------------------
  // Session state
  // ---------------------------------------------------------------------------

  /** Install a session as the signed-in one: memory, storage, active pointer. */
  private async startSession(user: User, tokens: SessionTokens): Promise<void> {
    this.adoptSessionTokens(tokens.accessToken, tokens.refreshToken || null);
    this._user.set(user);
    if (tokens.refreshToken) {
      const serverUrl = this.serverConfig.serverUrl();
      await this.sessions.save({
        serverUrl,
        user,
        // Web rides the httpOnly cookie; a second copy would add exposure only.
        accessToken: this.cookieAuth ? null : tokens.accessToken,
        refreshToken: tokens.refreshToken,
        refreshExpiresAt: tokens.refreshExpiresAt,
        lastUsedAt: Date.now(),
      });
      await this.sessions.setActive(serverUrl, user.id);
    } else {
      // Nothing to resume later, so nothing may stay flagged as signed in.
      await this.sessions.clearActive();
    }
    this._sessionEpoch.update((n) => n + 1);
  }

  /** Forget the signed-in session locally and send the user back to the picker.
   *  Used by logout and by a terminal credential rejection. */
  private async dropActiveSession(): Promise<void> {
    const active = this.sessions.active();
    if (active) await this.sessions.remove(active.serverUrl, active.user.id);
    this.clearInMemorySession();
    await this.serverCache.clearAll();
    void this.router.navigate(['/select-user'], { replaceUrl: true });
  }

  private adoptSessionTokens(
    accessToken: string | null,
    refreshToken: string | null,
  ): void {
    this._accessToken = accessToken;
    this._refreshToken = refreshToken;
    this.resetStreamToken();
  }

  /** Drop everything session-bound from memory, leaving stored sessions alone. */
  private clearInMemorySession(): void {
    this._refreshInFlight = null;
    this._streamTokenInFlight = null;
    this.adoptSessionTokens(null, null);
    this._user.set(null);
    this._sessionEpoch.update((n) => n + 1);
  }

  /** The stream token authenticates playback URLs as one account — it must
   *  never outlive the session that minted it. */
  private resetStreamToken(): void {
    this._streamToken.set(null);
    this._streamTokenExpiresAt = 0;
  }

  /** Adopt the stored session into memory and return its profile. Synchronous
   *  and idempotent: the store is loaded before bootstrap, so guards can use it. */
  loadPersistedSession(): User | null {
    const active = this.sessions.active();
    if (!active) return null;
    if (!this._refreshToken) {
      this.adoptSessionTokens(active.accessToken, active.refreshToken);
    }
    return active.user;
  }

  /** Keep the stored profile in step with the server. */
  private async rememberUser(user: User): Promise<void> {
    const active = this.sessions.active();
    if (active) {
      await this.sessions.updateUser(active.serverUrl, active.user.id, user);
    }
  }

  /** Freshest persisted token. Re-read from storage on web, where another tab
   *  may have rotated it while we waited for the lock. */
  private async readStoredRefreshToken(): Promise<string | null> {
    if (this.cookieAuth) await this.sessions.load();
    return this.sessions.active()?.refreshToken ?? this._refreshToken;
  }
}
