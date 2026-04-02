import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface MediaServerRow {
  id: number;
  name: string;
  type: string;
  url: string;
  apiKey: string;
  events: string[];
  enabled: boolean;
}

export interface MediaServerTypeInfo {
  type: string;
  label: string;
  supportedEvents: string[];
}

export interface CreateMediaServerBody {
  name: string;
  type: string;
  url: string;
  apiKey?: string;
  events?: string[];
  enabled?: boolean;
}

@Injectable({ providedIn: 'root' })
export class MediaServersApiService {
  private readonly http = inject(HttpClient);

  getTypes() {
    return firstValueFrom(
      this.http.get<MediaServerTypeInfo[]>('/api/media-servers/types'),
    );
  }

  list() {
    return firstValueFrom(
      this.http.get<MediaServerRow[]>('/api/media-servers'),
    );
  }

  get(id: number) {
    return firstValueFrom(
      this.http.get<MediaServerRow>(`/api/media-servers/${id}`),
    );
  }

  create(body: CreateMediaServerBody) {
    return firstValueFrom(
      this.http.post<MediaServerRow>('/api/media-servers', body),
    );
  }

  update(id: number, body: Partial<CreateMediaServerBody>) {
    return firstValueFrom(
      this.http.put<MediaServerRow>(`/api/media-servers/${id}`, body),
    );
  }

  remove(id: number) {
    return firstValueFrom(
      this.http.delete<void>(`/api/media-servers/${id}`),
    );
  }

  testConnection(id: number) {
    return firstValueFrom(
      this.http.post<{ ok: boolean; message: string }>(
        `/api/media-servers/${id}/test`,
        {},
      ),
    );
  }
}
