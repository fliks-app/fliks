import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SKIP_ERROR_TOAST } from '../../interceptors/error.interceptor';
import { CacheRead, cacheHeaders } from '../../interceptors/cache.interceptor';
import type { MediaType } from '../../enums/media-type.enum';

/** Lightweight library projection for non-admin users (sidebar, route resolution). */
export interface LibrarySummary {
  id: number;
  name: string;
  icon: string | null;
  color: string | null;
  mediaTypes: MediaType[];
  defaultQualityProfileId: number | null;
  defaultLanguageProfileId: number | null;
}

export interface LibraryDiskMetrics {
  freeSpace: number;
  totalSpace: number;
  accessible: boolean;
}

/** One root folder of a library; the first by `position` is where new files go. */
export interface LibraryFolder {
  id: number;
  path: string;
  position: number;
  disk: LibraryDiskMetrics | null;
  mediaCount: number;
}

export interface UpdateLibraryFolderBody {
  path?: string;
  /** Zero-based index in the folder list. */
  position?: number;
}

export interface Library {
  id: number;
  name: string;
  icon: string | null;
  color: string | null;
  mediaTypes: MediaType[];
  preferredProvider: string | null;
  metadataLanguage: string | null;
  metadataRegion: string | null;
  defaultQualityProfileId: number | null;
  defaultLanguageProfileId: number | null;
  /** First folder, kept for older clients: `folders` is the list. */
  path: string | null;
  label: string | null;
  disk: LibraryDiskMetrics | null;
  folders: LibraryFolder[];
  userIds: number[];
}

export interface CreateLibraryBody {
  name: string;
  icon?: string | null;
  color?: string | null;
  mediaTypes?: MediaType[];
  preferredProvider?: string | null;
  metadataLanguage?: string | null;
  metadataRegion?: string | null;
  defaultQualityProfileId?: number | null;
  defaultLanguageProfileId?: number | null;
  path?: string;
  userIds?: number[];
}

export type UpdateLibraryBody = Partial<Omit<CreateLibraryBody, 'userIds'>>;

@Injectable({ providedIn: 'root' })
export class LibrariesApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<Library[]>('/api/libraries'));
  }

  /** User-accessible lightweight list (sidebar, route resolution). */
  listMine(opts: CacheRead = {}) {
    return firstValueFrom(
      this.http.get<LibrarySummary[]>(
        '/api/libraries/mine',
        { headers: cacheHeaders(opts) },
      ),
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

  addFolder(libraryId: number, path: string) {
    return firstValueFrom(
      this.http.post<LibraryFolder>(`/api/libraries/${libraryId}/folders`, { path }),
    );
  }

  updateFolder(libraryId: number, folderId: number, body: UpdateLibraryFolderBody) {
    return firstValueFrom(
      this.http.patch<LibraryFolder>(`/api/libraries/${libraryId}/folders/${folderId}`, body),
    );
  }

  /** Answers 409 `folder_in_use` while files are linked; `removeMedia` drops those media from Fliks instead, files kept. The caller reports the failure. */
  removeFolder(libraryId: number, folderId: number, removeMedia = false) {
    return firstValueFrom(
      this.http.delete<void>(`/api/libraries/${libraryId}/folders/${folderId}`, {
        params: removeMedia ? { removeMedia: true } : {},
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      }),
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
