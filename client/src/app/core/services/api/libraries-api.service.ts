import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export type StalledCleanupProfileKey = 'fast' | 'medium' | 'slow';

/** Lightweight library projection for non-admin users (sidebar, route resolution). */
export interface LibrarySummary {
  id: number;
  name: string;
  icon: string | null;
  color: string | null;
  mediaTypes: ('movie' | 'series')[];
  isDefaultForMovies: boolean;
  isDefaultForSeries: boolean;
}

export interface LibraryRootFolder {
  id: number;
  path: string;
  label: string | null;
  freeSpace: number;
  totalSpace: number;
  accessible: boolean;
}

export interface Library {
  id: number;
  name: string;
  icon: string | null;
  color: string | null;
  mediaTypes: ('movie' | 'series')[];
  preferredProvider: string | null;
  stalledCleanupProfile: StalledCleanupProfileKey | null;
  defaultQualityProfileId: number | null;
  defaultLanguageProfileId: number | null;
  isDefaultForMovies: boolean;
  isDefaultForSeries: boolean;
  rootFolders: LibraryRootFolder[];
  userIds: number[];
}

export interface CreateLibraryBody {
  name: string;
  icon?: string | null;
  color?: string | null;
  mediaTypes?: ('movie' | 'series')[];
  preferredProvider?: string | null;
  stalledCleanupProfile?: StalledCleanupProfileKey | null;
  defaultQualityProfileId?: number | null;
  defaultLanguageProfileId?: number | null;
  isDefaultForMovies?: boolean;
  isDefaultForSeries?: boolean;
  paths?: string[];
  userIds?: number[];
}

export type UpdateLibraryBody = Partial<Omit<CreateLibraryBody, 'paths' | 'userIds'>>;

@Injectable({ providedIn: 'root' })
export class LibrariesApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<Library[]>('/api/libraries'));
  }

  /** User-accessible lightweight list (sidebar, route resolution). */
  listMine() {
    return firstValueFrom(
      this.http.get<LibrarySummary[]>('/api/libraries/mine'),
    );
  }

  get(id: number) {
    return firstValueFrom(this.http.get<Library>(`/api/libraries/${id}`));
  }

  create(body: CreateLibraryBody) {
    return firstValueFrom(this.http.post<Library>('/api/libraries', body));
  }

  update(id: number, body: UpdateLibraryBody) {
    return firstValueFrom(this.http.patch<Library>(`/api/libraries/${id}`, body));
  }

  remove(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/libraries/${id}`));
  }

  addPath(id: number, body: { path: string; label?: string }) {
    return firstValueFrom(
      this.http.post<LibraryRootFolder>(`/api/libraries/${id}/paths`, body),
    );
  }

  removePath(id: number, pathId: number) {
    return firstValueFrom(
      this.http.delete<void>(`/api/libraries/${id}/paths/${pathId}`),
    );
  }

  getAccess(id: number) {
    return firstValueFrom(
      this.http.get<number[]>(`/api/libraries/${id}/access`),
    );
  }

  setAccess(id: number, userIds: number[]) {
    return firstValueFrom(
      this.http.put<void>(`/api/libraries/${id}/access`, { userIds }),
    );
  }
}
