import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface SubtitleProviderRow {
  id: number;
  name: string;
  type: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  priority: number;
}

export interface CreateSubtitleProviderBody {
  name: string;
  type: string;
  settings?: Record<string, unknown>;
  enabled?: boolean;
  priority?: number;
}

export interface TestSubtitleProviderBody {
  type: string;
  settings?: Record<string, unknown>;
}

export interface ProviderRateLimit {
  providerType: string;
  retryAfter: number;
  remaining: number | null;
  delaySec: number;
}

@Injectable({ providedIn: 'root' })
export class SubtitleProvidersApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<SubtitleProviderRow[]>('/api/subtitles/providers'));
  }

  get(id: number) {
    return firstValueFrom(this.http.get<SubtitleProviderRow>(`/api/subtitles/providers/${id}`));
  }

  create(body: CreateSubtitleProviderBody) {
    return firstValueFrom(this.http.post<SubtitleProviderRow>('/api/subtitles/providers', body));
  }

  update(id: number, body: Partial<CreateSubtitleProviderBody>) {
    return firstValueFrom(this.http.put<SubtitleProviderRow>(`/api/subtitles/providers/${id}`, body));
  }

  remove(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/subtitles/providers/${id}`));
  }

  testConnection(body: TestSubtitleProviderBody) {
    return firstValueFrom(
      this.http.post<boolean>('/api/subtitles/providers/test-connection', body),
    );
  }

  testProvider(id: number) {
    return firstValueFrom(
      this.http.post<boolean>(`/api/subtitles/providers/${id}/test`, {}),
    );
  }

  getRateLimits() {
    return firstValueFrom(
      this.http.get<ProviderRateLimit[]>('/api/subtitles/providers/rate-limits'),
    );
  }

  getStats(id: number) {
    return firstValueFrom(
      this.http.get<{ date: string; queries: number; avgResponseMs: number; totalResults: number; errors: number }[]>(
        `/api/subtitles/providers/${id}/stats`,
      ),
    );
  }
}
