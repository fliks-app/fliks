import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface RemoteGrant {
  id: number;
  deviceId: string;
  deviceName: string;
  /** Set on a device this account may control: who owns it. */
  ownerUsername: string | null;
  /** Set on a grant this device issued: who it authorized. */
  granteeUsername: string | null;
  createdAt: string;
}

/** Standing per-device control permissions: a code shown on a screen, claimed
 *  by whoever can read it. */
@Injectable({ providedIn: 'root' })
export class RemoteGrantsApiService {
  private readonly http = inject(HttpClient);

  createCode(deviceId: string, deviceName: string) {
    return firstValueFrom(
      this.http.post<{ id: number; code: string; expiresIn: number }>(
        '/api/remote/grants/code',
        { deviceId, deviceName },
      ),
    );
  }

  claim(code: string) {
    return firstValueFrom(
      this.http.post<RemoteGrant>('/api/remote/grants/claim', { code }),
    );
  }

  /** `issued` is scoped to the asking device; `held` follows the account. */
  list(deviceId: string) {
    return firstValueFrom(
      this.http.get<{ issued: RemoteGrant[]; held: RemoteGrant[] }>(
        '/api/remote/grants',
        { params: { deviceId } },
      ),
    );
  }

  revoke(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/remote/grants/${id}`));
  }
}
