import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, catchError, firstValueFrom, map, of, tap } from 'rxjs';
import { ServerConfigService } from './server-config.service';
import { ServerCacheService } from './server-cache.service';
import { Preferences } from '@capacitor/preferences';

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

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly serverCache = inject(ServerCacheService);

  private static readonly TOKEN_KEY = 'fliks_access_token';
  private static readonly REFRESH_KEY = 'fliks_refresh_token';

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

  constructor() {
    // Multi-tab: when another tab rotates the refresh token it persists the new
    // value to localStorage, firing `storage` in every OTHER tab. Adopt it so a
    // lagging tab never replays its now-stale token — which the server treats as
    // reuse and revokes every session. Web-only (native runs a single webview).
    if (typeof window !== 'undefined' && !this.serverConfig.isNative) {
      window.addEventListener('storage', (e) => {
        if (e.key === AuthService.REFRESH_KEY && e.newValue) {
          this._refreshToken = e.newValue;
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
    // so the new login starts on a clean slate and `_user` / `_accessToken`
    // are then set in a single block without an async point between them
    // where a stray effect could observe a mid-update inconsistency.
    await this.serverCache.clearAll();
    const res = await firstValueFrom(
      this.http.post<LoginResponse>('/api/auth/login', { username, password }),
    );
    if (res.accessToken) {
      this._accessToken = res.accessToken;
      if (this.serverConfig.isNative) await this.saveToken(res.accessToken);
    }
    if (res.refreshToken) {
      this._refreshToken = res.refreshToken;
      await this.saveRefreshToken(res.refreshToken);
    }
    this._user.set(res.user);
    // Fire-and-forget — bumps the active server in the known-servers list
    // so it surfaces first in /setup next time. Awaiting here could block
    // the login spinner if Preferences write stalled.
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
  ): Promise<void> {
    this._accessToken = accessToken;
    if (this.serverConfig.isNative) await this.saveToken(accessToken);
    if (refreshToken) {
      this._refreshToken = refreshToken;
      await this.saveRefreshToken(refreshToken);
    }
    await this.serverCache.clearAll();
    const user = await firstValueFrom(this.http.get<User>('/api/auth/me'));
    this._user.set(user);
    const activeUrl = this.serverConfig.serverUrl();
    if (activeUrl) {
      await this.serverConfig.addOrTouchKnownServer(activeUrl, { username: user.username });
    }
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
   * rejection is terminal — the local session is wiped and the user is sent
   * back to /select-user. Network/5xx failures keep the tokens so a flaky
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
    if (!this.serverConfig.isNative && lockMgr) {
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
    const stored = await this.loadRefreshToken();
    if (!this.serverConfig.isNative && stored && stored !== tokenAtStart) {
      this._refreshToken = stored;
      return true;
    }
    return this.doRefresh(stored ?? tokenAtStart);
  }

  private async doRefresh(refresh: string | null): Promise<boolean> {
    if (!refresh) return false;
    try {
      const res = await firstValueFrom(
        this.http.post<TokenPairResponse>('/api/auth/refresh', {
          refreshToken: refresh,
        }),
      );
      this._accessToken = res.accessToken;
      this._refreshToken = res.refreshToken;
      if (this.serverConfig.isNative) await this.saveToken(res.accessToken);
      await this.saveRefreshToken(res.refreshToken);
      return true;
    } catch (err) {
      const status = err instanceof HttpErrorResponse ? err.status : 0;
      // 4xx = server-side rejection (expired / revoked / theft-detection).
      // Anything else (0 = offline, 5xx = hiccup) is transient: keep the tokens
      // so a flaky connection doesn't log the user out.
      if (status >= 400 && status < 500) {
        // First check whether another tab rotated meanwhile: then our token was
        // merely stale, not dead — adopt the new one and let the caller retry
        // (against the fresh access cookie) instead of wiping the session.
        const stored = await this.loadRefreshToken();
        if (!this.serverConfig.isNative && stored && stored !== refresh) {
          this._refreshToken = stored;
          return true;
        }
        // Terminal — skip the /auth/logout round-trip (credentials are dead)
        // and send the user back to the picker.
        await this.clearLocalSession();
      }
      return false;
    }
  }

  /**
   * Ensure a fresh stream token is cached. Fetched on first call, then
   * re-used as long as it has > 30 min of life left — playback URLs are
   * baked at \`engine.load()\` time and can't be updated mid-stream, so
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

  /** Hydrate la session depuis le cookie ou token stocké (appelé au démarrage). */
  async hydrateFromServer(): Promise<void> {
    if (this._user()) return;
    if (this.serverConfig.isNative) {
      this._accessToken = await this.loadToken();
    }
    // Refresh token is loaded on every platform — the credentials
    // interceptor uses it to recover from 401s even when the cookie
    // is the primary auth carrier (it expires too).
    this._refreshToken = await this.loadRefreshToken();
    try {
      const user = await firstValueFrom(this.http.get<User>('/api/auth/me'));
      this._user.set(user);
    } catch {
      this._user.set(null);
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
    } catch {
      // Keep the previous user — refresh is best-effort.
    }
  }

  /** Locally merge fields into the current user after a self-update, so signal
   *  consumers react without a round-trip to /auth/me. */
  patchUser(partial: Partial<User>): void {
    this._user.update((u) => (u ? { ...u, ...partial } : u));
  }

  /** Pour le garde de route : vérifie le cookie/token et charge l'utilisateur si besoin. */
  ensureAuthenticated(): Observable<boolean> {
    if (this._user()) return of(true);

    // Fast path: if we have a cached user (from previous login), use it immediately
    // and validate the token in background (no blocking)
    const cached = this.loadCachedUser();

    if (this.serverConfig.isNative && !this._accessToken) {
      return new Observable<boolean>((subscriber) => {
        this.loadToken().then((token) => {
          this._accessToken = token;
          if (cached && token) {
            // Instant: use cached user, validate in background
            this._user.set(cached);
            subscriber.next(true);
            subscriber.complete();
            this.validateTokenInBackground();
          } else {
            // No cache: must wait for API
            this.http.get<User>('/api/auth/me').pipe(
              tap((u) => { this._user.set(u); this.cacheUser(u); }),
              map(() => true as boolean),
              catchError((err) => this.handleAuthError(err)),
            ).subscribe(subscriber);
          }
        });
      });
    }

    if (cached) {
      // Instant: use cached user, validate in background
      this._user.set(cached);
      this.validateTokenInBackground();
      return of(true);
    }

    return this.http.get<User>('/api/auth/me').pipe(
      tap((u) => { this._user.set(u); this.cacheUser(u); }),
      map(() => true),
      catchError((err) => this.handleAuthError(err)),
    );
  }

  /** Validate token in background — if 401, force logout. Network errors are ignored. */
  private validateTokenInBackground() {
    this.http.get<User>('/api/auth/me').subscribe({
      next: (u) => { this._user.set(u); this.cacheUser(u); },
      error: (err) => {
        const status = (err as { status?: number })?.status ?? 0;
        if (status === 401 || status === 403) {
          this._user.set(null);
          localStorage.removeItem('fliks.cachedUser');
        }
        // Network errors: ignore (already using cached user)
      },
    });
  }

  /** Distinguish 401 (expired token → logout) from network error (offline → keep user). */
  private handleAuthError(err: unknown): Observable<boolean> {
    const status = (err as { status?: number })?.status ?? 0;
    if (status === 401 || status === 403) {
      // Token expired or invalid → force logout
      this._user.set(null);
      return of(false);
    }
    // Network error (status 0, timeout, unreachable) → try cached user
    const cached = this.loadCachedUser();
    if (cached) {
      this._user.set(cached);
      return of(true); // Allow navigation in offline mode
    }
    this._user.set(null);
    return of(false);
  }

  private cacheUser(user: User) {
    try { localStorage.setItem('fliks.cachedUser', JSON.stringify(user)); } catch {}
  }

  private loadCachedUser(): User | null {
    try {
      const raw = localStorage.getItem('fliks.cachedUser');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  async logout(): Promise<void> {
    const refresh = this._refreshToken;
    try {
      await firstValueFrom(
        this.http.post('/api/auth/logout', refresh ? { refreshToken: refresh } : {}),
      );
    } finally {
      await this.clearLocalSession();
    }
  }

  /**
   * Wipe the local session and send the user back to the picker. Shared
   * between the user-initiated logout (dropdown) and the auto-logout
   * fired when the server rejects a refresh-token rotation. The picker
   * is the canonical "fresh visit" landing — the password form is one
   * tap away (picker → user → 'Mot de passe').
   */
  private async clearLocalSession(): Promise<void> {
    this._user.set(null);
    await this.clearTokens();
    try {
      localStorage.removeItem('fliks.cachedUser');
    } catch {
      // ignore
    }
    await this.serverCache.clearAll();
    void this.router.navigate(['/select-user'], { replaceUrl: true });
  }

  /**
   * Drop every credential scoped to the previously-active server so the next
   * request re-mints against the server the user just switched to. Tokens are
   * stored under fixed, non-server-keyed names, so a switch must WIPE rather
   * than swap: the old access/refresh/stream tokens would otherwise leak into
   * the Bearer header (credentials interceptor) and into every streaming URL
   * (StreamingApiService.playbackToken prefers the cached stream token), which
   * the new server rejects with 401 — breaking the whole playback path.
   *
   * Unlike {@link clearLocalSession} this does NOT navigate: the switch sites
   * (setup save/useKnown, select-user changeServer) own their own redirect.
   * In-flight refresh / stream-token fetches tied to the old server are dropped
   * so they can't repopulate state after the wipe.
   */
  async resetForServerSwitch(): Promise<void> {
    this._refreshInFlight = null;
    this._streamTokenInFlight = null;
    this._user.set(null);
    await this.clearTokens();
    try {
      localStorage.removeItem('fliks.cachedUser');
    } catch {
      // ignore
    }
    await this.serverCache.clearAll();
  }

  // ---------------------------------------------------------------------------
  // Token persistence — Preferences on native (survives app restarts reliably),
  // localStorage as fallback on web or if Preferences fails.
  // ---------------------------------------------------------------------------

  private async saveToken(token: string): Promise<void> {
    if (this.serverConfig.isNative) {
      try {
        await Preferences.set({ key: AuthService.TOKEN_KEY, value: token });
        return;
      } catch { /* fall through */ }
    }
    localStorage.setItem(AuthService.TOKEN_KEY, token);
  }

  private async loadToken(): Promise<string | null> {
    if (this.serverConfig.isNative) {
      try {
        const { value } = await Preferences.get({ key: AuthService.TOKEN_KEY });
        if (value) return value;
      } catch { /* fall through */ }
    }
    return localStorage.getItem(AuthService.TOKEN_KEY);
  }

  private async removeToken(): Promise<void> {
    if (this.serverConfig.isNative) {
      try {
        await Preferences.remove({ key: AuthService.TOKEN_KEY });
      } catch { /* fall through */ }
    }
    localStorage.removeItem(AuthService.TOKEN_KEY);
  }

  /** Refresh token — kept in Preferences on native, localStorage on web.
   *  Same dual-mode storage as the access token, separate key. */
  private async saveRefreshToken(token: string): Promise<void> {
    if (this.serverConfig.isNative) {
      try {
        await Preferences.set({ key: AuthService.REFRESH_KEY, value: token });
        return;
      } catch { /* fall through */ }
    }
    localStorage.setItem(AuthService.REFRESH_KEY, token);
  }

  private async loadRefreshToken(): Promise<string | null> {
    if (this.serverConfig.isNative) {
      try {
        const { value } = await Preferences.get({
          key: AuthService.REFRESH_KEY,
        });
        if (value) return value;
      } catch { /* fall through */ }
    }
    return localStorage.getItem(AuthService.REFRESH_KEY);
  }

  private async removeRefreshToken(): Promise<void> {
    if (this.serverConfig.isNative) {
      try {
        await Preferences.remove({ key: AuthService.REFRESH_KEY });
      } catch { /* fall through */ }
    }
    localStorage.removeItem(AuthService.REFRESH_KEY);
  }

  /** Clear all tokens (in-memory + persisted). Called when refresh
   *  fails terminally or on logout. */
  private async clearTokens(): Promise<void> {
    this._accessToken = null;
    this._refreshToken = null;
    this._streamToken.set(null);
    this._streamTokenExpiresAt = 0;
    await this.removeToken();
    await this.removeRefreshToken();
  }
}
