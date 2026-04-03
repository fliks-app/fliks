import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, catchError, firstValueFrom, map, of, tap } from 'rxjs';
import { ServerConfigService } from './server-config.service';

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

  private readonly _user = signal<User | null>(null);
  private _accessToken: string | null = null;

  get accessToken(): string | null {
    return this._accessToken;
  }

  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => !!this._user());

  /** Check if the current user has a specific permission. */
  hasPermission(perm: string): boolean {
    return this._user()?.permissions?.includes(perm) ?? false;
  }

  /** Convenience: true if the user has settings.access permission. */
  readonly canAccessSettings = computed(() =>
    this._user()?.permissions?.includes('settings.access') ?? false,
  );

  /** Convenience: true if the user can manage users. */
  readonly canManageUsers = computed(() =>
    this._user()?.permissions?.includes('users.manage') ?? false,
  );

  async login(username: string, password: string): Promise<LoginResponse> {
    const res = await firstValueFrom(
      this.http.post<LoginResponse>('/api/auth/login', { username, password }),
    );
    this._user.set(res.user);
    if (this.serverConfig.isNative && res.accessToken) {
      this._accessToken = res.accessToken;
      localStorage.setItem('suitarr_access_token', res.accessToken);
    }
    return res;
  }

  register(username: string, password: string, email?: string) {
    return firstValueFrom(
      this.http.post<User>('/api/auth/register', { username, password, email }),
    );
  }

  /** Hydrate la session depuis le cookie ou token stocké (appelé au démarrage). */
  hydrateFromServer(): void {
    if (this._user()) return;
    if (this.serverConfig.isNative) {
      this._accessToken = localStorage.getItem('suitarr_access_token');
    }
    firstValueFrom(this.http.get<User>('/api/auth/me')).then(
      (user) => this._user.set(user),
      () => this._user.set(null),
    );
  }

  /** Pour le garde de route : vérifie le cookie/token et charge l'utilisateur si besoin. */
  ensureAuthenticated(): Observable<boolean> {
    if (this._user()) return of(true);
    if (this.serverConfig.isNative && !this._accessToken) {
      this._accessToken = localStorage.getItem('suitarr_access_token');
    }
    return this.http.get<User>('/api/auth/me').pipe(
      tap((u) => this._user.set(u)),
      map(() => true),
      catchError(() => {
        this._user.set(null);
        return of(false);
      }),
    );
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/api/auth/logout', {}));
    } finally {
      this._user.set(null);
      this._accessToken = null;
      localStorage.removeItem('suitarr_access_token');
      void this.router.navigate(['/login']);
    }
  }
}
