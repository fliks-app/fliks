import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface IndexerRow {
  id: number;
  name: string;
  implementation: string;
  settings: Record<string, unknown>;
  enableRss: boolean;
  enableSearch: boolean;
  priority: number;
  enabled: boolean;
  tags?: { id: number; label: string }[];
}

export interface CreateIndexerBody {
  name: string;
  implementation: 'torznab';
  settings?: Record<string, unknown>;
  enableRss?: boolean;
  enableSearch?: boolean;
  priority?: number;
  enabled?: boolean;
  tagIds?: number[];
}

export interface TestIndexerConnectionBody {
  implementation: 'torznab';
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
}
