import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
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
}

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
  deviceName: string;
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
  private _refreshInFlight: Promise<string | null> | null = null;

  get accessToken(): string | null {
    return this._accessToken;
  }

  get refreshToken(): string | null {
    return this._refreshToken;
  }

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
  ): Promise<{ pairingId: string; expiresIn: number }> {
    return firstValueFrom(
      this.http.post<{ pairingId: string; expiresIn: number }>(
        '/api/auth/pairing/request',
        { userId, deviceName },
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
   * Exchange the stored refresh token for a fresh access + refresh
   * pair. Single-flight: parallel callers (e.g. 10 concurrent requests
   * all 401-ing at once) share the same in-flight promise so the
   * server only rotates the token once.
   *
   * Returns the new access token on success, or null if no refresh
   * token is stored / the rotation was rejected — the caller is then
   * expected to redirect to login.
   */
  async refreshAccessToken(): Promise<string | null> {
    if (this._refreshInFlight) return this._refreshInFlight;
    const refresh = this._refreshToken;
    if (!refresh) return null;
    this._refreshInFlight = (async () => {
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
        return res.accessToken;
      } catch {
        // Refresh failed (expired, revoked, network) — clear and bail.
        this._accessToken = null;
        this._refreshToken = null;
        await this.clearTokens();
        return null;
      } finally {
        this._refreshInFlight = null;
      }
    })();
    return this._refreshInFlight;
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
      this._user.set(null);
      await this.clearTokens();
      await this.serverCache.clearAll();
      // Land on the user picker, same as a fresh visit. The password form
      // is one tap away via the picker → user → 'Mot de passe'.
      void this.router.navigate(['/select-user']);
    }
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

  /** Clear both tokens (in-memory + persisted). Called when refresh
   *  fails terminally or on logout. */
  private async clearTokens(): Promise<void> {
    this._accessToken = null;
    this._refreshToken = null;
    await this.removeToken();
    await this.removeRefreshToken();
  }
}
