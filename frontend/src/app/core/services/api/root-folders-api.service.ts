import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface RootFolder {
  id: number;
  path: string;
  label?: string;
  mediaTypes: ('movie' | 'series')[];
  preferredProvider: string | null;
  freeSpace: number;
  totalSpace: number;
  accessible: boolean;
}

@Injectable({ providedIn: 'root' })
export class RootFoldersApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<RootFolder[]>('/api/root-folders'));
  }

  create(body: { path: string; label?: string; mediaTypes?: ('movie' | 'series')[]; preferredProvider?: string | null }) {
    return firstValueFrom(this.http.post<RootFolder>('/api/root-folders', body));
  }

  update(id: number, body: { path?: string; label?: string; mediaTypes?: ('movie' | 'series')[]; preferredProvider?: string | null }) {
    return firstValueFrom(this.http.patch<RootFolder>(`/api/root-folders/${id}`, body));
  }

  remove(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/root-folders/${id}`));
  }
}
