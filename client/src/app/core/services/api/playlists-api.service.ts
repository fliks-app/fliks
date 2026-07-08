import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { CACHE_BYPASS_HEADER } from '../../interceptors/cache.interceptor';
import { Media } from './media.service';

export type PlaylistRole = 'owner' | 'administrator' | 'editor' | 'viewer';

export interface Playlist {
  id: number;
  name: string;
  ownerId: number;
  role: PlaylistRole;
  autoRemoveWatched: boolean;
  autoDownload: boolean;
  coverImageUrl: string | null;
  itemCount: number;
  /** First up-to-4 poster URLs for the card mosaic (per-viewer). */
  posters: string[];
}

export interface PlaylistItem {
  itemId: number;
  position: number;
  addedById: number | null;
  media: Media;
}

export interface CreatePlaylistBody {
  name: string;
  autoRemoveWatched?: boolean;
  autoDownload?: boolean;
}

export type UpdatePlaylistBody = Partial<CreatePlaylistBody>;

@Injectable({ providedIn: 'root' })
export class PlaylistsApiService {
  private readonly http = inject(HttpClient);

  list(opts: { force?: boolean } = {}) {
    const headers = opts.force ? { [CACHE_BYPASS_HEADER]: '1' } : undefined;
    return firstValueFrom(
      this.http.get<Playlist[]>('/api/playlists', headers ? { headers } : {}),
    );
  }

  get(id: number, opts: { force?: boolean } = {}) {
    const headers = opts.force ? { [CACHE_BYPASS_HEADER]: '1' } : undefined;
    return firstValueFrom(
      this.http.get<Playlist>(`/api/playlists/${id}`, headers ? { headers } : {}),
    );
  }

  create(body: CreatePlaylistBody) {
    return firstValueFrom(this.http.post<Playlist>('/api/playlists', body));
  }

  update(id: number, body: UpdatePlaylistBody) {
    return firstValueFrom(this.http.patch<Playlist>(`/api/playlists/${id}`, body));
  }

  remove(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/playlists/${id}`));
  }

  items(id: number, opts: { force?: boolean } = {}) {
    const headers = opts.force ? { [CACHE_BYPASS_HEADER]: '1' } : undefined;
    return firstValueFrom(
      this.http.get<PlaylistItem[]>(
        `/api/playlists/${id}/items`,
        headers ? { headers } : {},
      ),
    );
  }

  addItem(id: number, mediaId: number) {
    return firstValueFrom(
      this.http.post<PlaylistItem>(`/api/playlists/${id}/items`, { mediaId }),
    );
  }

  reorder(id: number, itemIds: number[]) {
    return firstValueFrom(
      this.http.put<void>(`/api/playlists/${id}/items/order`, { itemIds }),
    );
  }

  removeItem(id: number, itemId: number) {
    return firstValueFrom(
      this.http.delete<void>(`/api/playlists/${id}/items/${itemId}`),
    );
  }
}
