import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

/** Live throttle state: why the indexer is being skipped, and until when. */
export interface IndexerCooldown {
  reason: 'rate-limit' | 'failures';
  remainingMs: number;
  /** ISO timestamp — the client recomputes the countdown from it. */
  until: string;
  failureCount?: number;
  detail?: string;
}

export interface IndexerRow {
  id: number;
  name: string;
  implementation: string;
  settings: Record<string, unknown>;
  enableRss: boolean;
  enableSearch: boolean;
  priority: number;
  requestDelay: number;
  enabled: boolean;
  /** Only the list endpoint reports it; create/update responses carry none. */
  cooldown?: IndexerCooldown | null;
}

/** `implementation` is `"torznab"` (manual URL) or a plugin-namespaced descriptor id. */
export interface CreateIndexerBody {
  name: string;
  implementation: string;
  settings?: Record<string, unknown>;
  enableRss?: boolean;
  enableSearch?: boolean;
  priority?: number;
  requestDelay?: number;
  enabled?: boolean;
}

export interface TestIndexerConnectionBody {
  implementation: string;
  settings: Record<string, unknown>;
}

export interface IndexerTestConnectionResult {
  ok: boolean;
  message: string;
}

@Injectable({ providedIn: 'root' })
export class IndexersApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<IndexerRow[]>('/api/indexers'));
  }

  get(id: number) {
    return firstValueFrom(this.http.get<IndexerRow>(`/api/indexers/${id}`));
  }

  create(body: CreateIndexerBody) {
    return firstValueFrom(this.http.post<IndexerRow>('/api/indexers', body));
  }

  update(id: number, body: Partial<CreateIndexerBody>) {
    return firstValueFrom(this.http.put<IndexerRow>(`/api/indexers/${id}`, body));
  }

  remove(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/indexers/${id}`));
  }

  testConnection(body: TestIndexerConnectionBody) {
    return firstValueFrom(
      this.http.post<IndexerTestConnectionResult>(
        '/api/indexers/test-connection',
        body,
      ),
    );
  }

  /** Lift the throttle window on one indexer. */
  clearCooldown(id: number) {
    return firstValueFrom(
      this.http.delete<{ cleared: boolean }>(`/api/indexers/${id}/cooldown`),
    );
  }

  /** Lift every throttle window. */
  clearAllCooldowns() {
    return firstValueFrom(
      this.http.delete<{ cleared: number }>('/api/indexers/cooldowns'),
    );
  }

  getStats(id: number) {
    return firstValueFrom(this.http.get<{ date: string; queries: number; avgResponseMs: number; totalResults: number; errors: number }[]>(`/api/indexers/${id}/stats`));
  }
}
