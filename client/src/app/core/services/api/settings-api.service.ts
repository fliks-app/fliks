import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface AppSetting {
  key: string;
  value: string | null;
}

/** Keys of the secret settings the server holds a value for but does not return. */
export function settingsSecretsSet(all: Record<string, unknown>): string[] {
  const v = all['secretsSet'];
  return Array.isArray(v) ? v.map(String) : [];
}

@Injectable({ providedIn: 'root' })
export class SettingsApiService {
  private readonly http = inject(HttpClient);

  getAll() {
    return firstValueFrom(this.http.get<Record<string, string | null>>('/api/settings'));
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
