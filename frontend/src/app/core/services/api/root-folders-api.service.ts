import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export type StalledCleanupProfileKey = 'fast' | 'medium' | 'slow';

export interface RootFolder {
  id: number;
  path: string;
  label?: string;
  mediaTypes: ('movie' | 'series')[];
  preferredProvider: string | null;
  stalledCleanupProfile: StalledCleanupProfileKey | null;
  freeSpace: number;
  totalSpace: number;
  accessible: boolean;
}

export interface CreateRootFolderBody {
  path: string;
  label?: string;
  mediaTypes?: ('movie' | 'series')[];
  preferredProvider?: string | null;
  stalledCleanupProfile?: StalledCleanupProfileKey | null;
}

export interface UpdateRootFolderBody {
  path?: string;
  label?: string;
  mediaTypes?: ('movie' | 'series')[];
  preferredProvider?: string | null;
  stalledCleanupProfile?: StalledCleanupProfileKey | null;
}

@Injectable({ providedIn: 'root' })
export class RootFoldersApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<RootFolder[]>('/api/root-folders'));
  }

  create(body: CreateRootFolderBody) {
    return firstValueFrom(this.http.post<RootFolder>('/api/root-folders', body));
  }

  update(id: number, body: UpdateRootFolderBody) {
    return firstValueFrom(this.http.patch<RootFolder>(`/api/root-folders/${id}`, body));
  }

  remove(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/root-folders/${id}`));
  }
}
