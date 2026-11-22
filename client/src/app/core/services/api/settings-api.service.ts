import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { SKIP_ERROR_TOAST } from '../../interceptors/error.interceptor';
import { firstValueFrom } from 'rxjs';
import { SECRETS_SET_KEY } from '@fliks/plugin-ui';

export interface AppSetting {
  key: string;
  value: string | null;
}

/** Keys of the secret settings the server holds a value for but does not return. */
export function settingsSecretsSet(all: Record<string, unknown>): string[] {
  const v = all[SECRETS_SET_KEY];
  return Array.isArray(v) ? v.map(String) : [];
}

@Injectable({ providedIn: 'root' })
export class SettingsApiService {
  private readonly http = inject(HttpClient);

  /** `quiet` suppresses the error toast for a caller that renders its own failed state. */
  getAll(quiet = false) {
    return firstValueFrom(
      this.http.get<Record<string, string | null>>('/api/settings', {
        context: new HttpContext().set(SKIP_ERROR_TOAST, quiet),
      }),
    );
  }

  get(key: string) {
    return firstValueFrom(this.http.get<AppSetting>(`/api/settings/${key}`));
  }

  set(key: string, value: string) {
    return firstValueFrom(this.http.put<AppSetting>(`/api/settings/${key}`, { value }));
  }

  setBulk(settings: Record<string, string | null>) {
    return firstValueFrom(this.http.put<{ ok: boolean }>('/api/settings', { data: settings }));
  }

  delete(key: string) {
    return firstValueFrom(this.http.delete<void>(`/api/settings/${key}`));
  }
}
