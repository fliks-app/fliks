import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SKIP_ERROR_TOAST } from '../../interceptors/error.interceptor';

export type OidcPrompt = 'none' | 'login' | 'consent' | 'select_account';

export interface OidcRoleMapping {
  group: string;
  roleId: number;
}

export interface OidcProviderRow {
  id: number;
  name: string;
  issuer: string;
  clientId: string;
  clientSecretSet: boolean;
  caPem: string | null;
  scope: string;
  prompt: OidcPrompt | null;
  usernameClaim: string;
  groupsClaim: string | null;
  allowedGroups: string[];
  adminGroups: string[];
  roleMappings: OidcRoleMapping[];
  autoRegister: boolean;
  matchByEmail: boolean;
  endSessionAtProvider: boolean;
  accountUrl: string | null;
  enabled: boolean;
  position: number;
  linkedUsers: number;
}

/** Body of POST and PUT; `clientSecret` blank keeps the stored one, `issuer` is ignored on PUT. */
export type OidcProviderBody = Omit<OidcProviderRow, 'id' | 'clientSecretSet' | 'linkedUsers' | 'position'> & {
  clientSecret: string;
  /** Absent keeps the position (create: after the last). */
  position?: number;
};

export type OidcTestResult =
  | { ok: true; issuer: string; algs: string[]; pkce: boolean; endSession: boolean; backchannel: boolean }
  | { ok: false; error: string };

export interface OidcIdentity {
  providerId: number;
  name: string;
  email: string | null;
  accountUrl: string | null;
  lastLoginAt: string | null;
}

@Injectable({ providedIn: 'root' })
export class OidcApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<OidcProviderRow[]>('/api/oidc-providers'));
  }

  create(body: OidcProviderBody) {
    return firstValueFrom(this.http.post<OidcProviderRow>('/api/oidc-providers', body));
  }

  update(id: number, body: OidcProviderBody) {
    return firstValueFrom(this.http.put<OidcProviderRow>(`/api/oidc-providers/${id}`, body));
  }

  remove(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/oidc-providers/${id}`));
  }

  test(issuer: string, caPem: string | null) {
    return firstValueFrom(
      this.http.post<OidcTestResult>('/api/oidc-providers/test', { issuer, ...(caPem ? { caPem } : {}) }, {
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      }),
    );
  }

  identities() {
    return firstValueFrom(
      this.http.get<{ hasPassword: boolean; identities: OidcIdentity[] }>('/api/auth/oidc/identities', {
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      }),
    );
  }

  unlink(providerId: number) {
    return firstValueFrom(this.http.delete<void>(`/api/auth/oidc/identities/${providerId}`));
  }

  /** Admin: remove a user's link to a provider. */
  unlinkUser(userId: number, providerId: number) {
    return firstValueFrom(this.http.delete<void>(`/api/users/${userId}/oidc/${providerId}`));
  }
}
