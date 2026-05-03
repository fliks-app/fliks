import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export type CleanupProfileKey = 'fast' | 'medium' | 'slow';

export interface CleanupProfile {
  key: CleanupProfileKey;
  samples: number;
  intervalMinutes: number;
  autoRestart: boolean;
}

export interface UpdateCleanupProfileDto {
  samples?: number;
  intervalMinutes?: number;
  autoRestart?: boolean;
}

@Injectable({ providedIn: 'root' })
export class CleanupProfilesApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(
      this.http.get<CleanupProfile[]>('/api/cleanup-profiles'),
    );
  }

  update(key: CleanupProfileKey, body: UpdateCleanupProfileDto) {
    return firstValueFrom(
      this.http.patch<CleanupProfile>(`/api/cleanup-profiles/${key}`, body),
    );
  }
}
