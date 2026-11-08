import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export type DeviceTokenKind = 'opds' | 'kosync' | 'kobo' | 'subsonic';

export interface DeviceToken {
  id: number;
  name: string;
  kind: DeviceTokenKind;
  createdAt: string;
  lastUsedAt: string | null;
}

/** The plaintext `token` comes back once, with its creation or renewal. */
export type IssuedDeviceToken = DeviceToken & { token: string };

/** Credentials of readers and sync apps that cannot log in. */
@Injectable({ providedIn: 'root' })
export class DeviceTokensApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<DeviceToken[]>('/api/device-tokens'));
  }

  create(name: string, kind: DeviceTokenKind) {
    return firstValueFrom(
      this.http.post<IssuedDeviceToken>('/api/device-tokens', { name, kind }),
    );
  }

  renew(id: number) {
    return firstValueFrom(
      this.http.post<IssuedDeviceToken>(`/api/device-tokens/${id}/renew`, {}),
    );
  }

  revoke(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/device-tokens/${id}`));
  }
}
