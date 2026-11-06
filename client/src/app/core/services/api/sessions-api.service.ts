import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface AuthSession {
  id: number;
  /** How it signed in; null for a session that predates the record. */
  method: string | null;
  /** The provider of an `oidc` session. */
  providerName?: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

/** The signed-in devices of the current user. */
@Injectable({ providedIn: 'root' })
export class SessionsApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<AuthSession[]>('/api/auth/sessions'));
  }

  revoke(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/auth/sessions/${id}`));
  }
}
