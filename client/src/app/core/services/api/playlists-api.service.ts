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

export interface PlaylistEpisode {
  id: number;
  episodeNumber: number;
  endEpisodeNumber?: number | null;
  title?: string | null;
  stillUrl?: string | null;
  season?: { seasonNumber: number } | null;
}

export interface PlaylistItem {
  itemId: number;
  position: number;
  addedById: number | null;
  /** The movie, or the parent series when the item is an episode. */
  media: Media;
  /** Set when the item is a single episode; null for a movie item. */
  episode: PlaylistEpisode | null;
  /** The viewer's watch progress on this item (0–100). */
  progressPercent: number;
  /** Whether the viewer finished this item. */
  watched: boolean;
}

export interface CreatePlaylistBody {
  name: string;
  autoRemoveWatched?: boolean;
  autoDownload?: boolean;
}

export type UpdatePlaylistBody = Partial<CreatePlaylistBody>;

/** Scope of an add: a movie/series (`mediaId`), a single `episodeId`, or a
 *  whole `seasonId`. Season/series expand to episodes server-side. */
export interface AddToPlaylistBody {
  mediaId?: number;
  episodeId?: number;
  seasonId?: number;
}

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

  addItem(id: number, body: AddToPlaylistBody) {
    return firstValueFrom(
      this.http.post<{ added: number }>(`/api/playlists/${id}/items`, body),
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
