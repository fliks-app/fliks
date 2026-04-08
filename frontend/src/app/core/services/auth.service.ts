import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, catchError, firstValueFrom, map, of, tap } from 'rxjs';
import { ServerConfigService } from './server-config.service';
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
}

interface LoginResponse {
  user: User;
  accessToken?: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly serverConfig = inject(ServerConfigService);

  private static readonly TOKEN_KEY = 'fliks_access_token';

  private readonly _user = signal<User | null>(null);
  private _accessToken: string | null = null;

  get accessToken(): string | null {
    return this._accessToken;
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
    const res = await firstValueFrom(
      this.http.post<LoginResponse>('/api/auth/login', { username, password }),
    );
    this._user.set(res.user);
    if (this.serverConfig.isNative && res.accessToken) {
      this._accessToken = res.accessToken;
      await this.saveToken(res.accessToken);
    }
    return res;
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
    try {
      const user = await firstValueFrom(this.http.get<User>('/api/auth/me'));
      this._user.set(user);
    } catch {
      this._user.set(null);
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
    try {
      await firstValueFrom(this.http.post('/api/auth/logout', {}));
    } finally {
      this._user.set(null);
      this._accessToken = null;
      await this.removeToken();
      void this.router.navigate(['/login']);
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
}
