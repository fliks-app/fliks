import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { MediaType } from '../../enums/media-type.enum';

export interface QbittorrentSettings {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  useSsl?: boolean;
  category?: string;
  movieCategory?: string;
  seriesCategory?: string;
}

export interface DownloadClientRow {
  id: number;
  name: string;
  implementation: string;
  settings: QbittorrentSettings;
  priority: number;
  enabled: boolean;
}

export interface CreateDownloadClientBody {
  name: string;
  implementation: 'qbittorrent';
  settings: QbittorrentSettings;
  priority?: number;
  enabled?: boolean;
}

export interface TestDownloadClientBody {
  settings: QbittorrentSettings;
  implementation: 'qbittorrent';
}

export interface QueueItem {
  hash: string;
  name: string;
  size: number;
  downloaded: number;
  progress: number;
  state: string;
  trackerStatus: string;
  status: string;
  eta: number;
  dlspeed: number;
  upspeed: number;
  category: string;
  save_path: string;
  num_seeds: number;
  num_leechs: number;
  added_on: number;
  clientId: number;
  clientName: string;
  mediaId?: number;
  mediaTitle?: string;
  mediaType?: MediaType;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string | null;
  indexerName?: string;
  statusMessage?: string;
}

export interface QueueResult {
  items: QueueItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface QueueQuery {
  page?: number;
  pageSize?: number;
  torrentStatus?: string;
  fliksStatus?: string;
  search?: string;
}

@Injectable({ providedIn: 'root' })
export class DownloadClientsApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<DownloadClientRow[]>('/api/download-clients'));
  }

  get(id: number) {
    return firstValueFrom(this.http.get<DownloadClientRow>(`/api/download-clients/${id}`));
  }

  create(body: CreateDownloadClientBody) {
    return firstValueFrom(this.http.post<DownloadClientRow>('/api/download-clients', body));
  }

  update(id: number, body: Partial<CreateDownloadClientBody>) {
    return firstValueFrom(this.http.put<DownloadClientRow>(`/api/download-clients/${id}`, body));
  }

  remove(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/download-clients/${id}`));
  }

  testConnection(body: TestDownloadClientBody) {
    return firstValueFrom(
      this.http.post<{ ok: boolean; message: string }>(
        '/api/download-clients/test-connection',
        body,
      ),
    );
  }

  getQueue(query: QueueQuery = {}) {
    let params = new HttpParams();
    if (query.page) params = params.set('page', query.page);
    if (query.pageSize) params = params.set('pageSize', query.pageSize);
    if (query.torrentStatus) params = params.set('torrentStatus', query.torrentStatus);
    if (query.fliksStatus) params = params.set('fliksStatus', query.fliksStatus);
    if (query.search) params = params.set('search', query.search);
    return firstValueFrom(
      this.http.get<QueueResult>('/api/download-clients/queue', { params }),
    );
  }

  removeTorrent(hash: string, clientId: number, deleteFiles = false) {
    return firstValueFrom(
      this.http.delete<void>(
        `/api/download-clients/queue/${hash}`,
        { params: { clientId, deleteFiles } },
      ),
    );
  }

  reimport(hash: string) {
    return firstValueFrom(this.http.post<void>(`/api/download-clients/queue/${hash}/reimport`, {}));
  }

  blockTorrent(hash: string, clientId: number) {
    return firstValueFrom(
      this.http.post<void>(
        `/api/download-clients/queue/${hash}/block`,
        {},
        { params: { clientId } },
      ),
    );
  }

  triggerImport() {
    return firstValueFrom(this.http.post('/api/commands', { name: 'ImportCompleted' }));
  }
}
