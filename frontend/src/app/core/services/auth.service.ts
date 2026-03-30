import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, catchError, firstValueFrom, map, of, tap } from 'rxjs';

export interface User {
  id: number;
  username: string;
  email: string;
  role: string;
  apiKey: string;
  avatar: string | null;
}

interface LoginResponse {
  user: User;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  private readonly _user = signal<User | null>(null);

  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => !!this._user());
  readonly isAdmin = computed(() => this._user()?.role === 'admin');

  async login(username: string, password: string): Promise<LoginResponse> {
    const res = await firstValueFrom(
      this.http.post<LoginResponse>('/api/auth/login', { username, password }),
    );
    this._user.set(res.user);
    return res;
  }

  register(username: string, password: string, email?: string) {
    return firstValueFrom(
      this.http.post<User>('/api/auth/register', { username, password, email }),
    );
  }

  /** Hydrate la session depuis le cookie (appelé au démarrage). */
  hydrateFromServer(): void {
    if (this._user()) return;
    firstValueFrom(this.http.get<User>('/api/auth/me')).then(
      (user) => this._user.set(user),
      () => this._user.set(null),
    );
  }

  /** Pour le garde de route : vérifie le cookie et charge l'utilisateur si besoin. */
  ensureAuthenticated(): Observable<boolean> {
    if (this._user()) return of(true);
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
      void this.router.navigate(['/login']);
    }
  }
}
