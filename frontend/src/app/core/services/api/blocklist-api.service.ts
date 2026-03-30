import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface BlocklistEntry {
  id: number;
  sourceTitle: string;
  indexerName?: string;
  quality?: string;
  note?: string;
  createdAt: string;
}

export interface BlocklistPage {
  data: BlocklistEntry[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable({ providedIn: 'root' })
export class BlocklistApiService {
  private readonly http = inject(HttpClient);

  list(page = 1, pageSize = 20) {
    return firstValueFrom(
      this.http.get<BlocklistPage>('/api/blocklist', {
        params: { page, pageSize },
      }),
    );
  }

  remove(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/blocklist/${id}`));
  }

  clear() {
    return firstValueFrom(this.http.delete<void>('/api/blocklist/all'));
  }
}
