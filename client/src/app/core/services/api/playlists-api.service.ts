import { Injectable, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { CacheRead, cacheHeaders } from '../../interceptors/cache.interceptor';
import { Media } from './media.service';
import { SERVER_SINCE, ServerVersionService } from '../server-version.service';
import type { SmartRules } from './smart-rules';

export type PlaylistRole = 'owner' | 'administrator' | 'editor' | 'viewer';
/** Roles that can be granted to a member (owner is not grantable). */
export type PlaylistShareRole = 'administrator' | 'editor' | 'viewer';

export interface PlaylistMember {
  userId: number;
  username: string;
  avatar: string | null;
  role: PlaylistRole;
}

/** Who can read the playlist. */
export type PlaylistVisibility = 'private' | 'followers' | 'public';

export interface Playlist {
  id: number;
  name: string;
  ownerId: number;
  role: PlaylistRole;
  autoRemoveWatched: boolean;
  /** Play the playlist's items back to back (server-side, per playlist). */
  autoPlay: boolean;
  /** Read scope: owner-only, the owner's accepted followers, or any member. */
  visibility: PlaylistVisibility;
  /** True when this playlist is in the caller's list because they saved it. */
  saved: boolean;
  coverImageUrl: string | null;
  itemCount: number;
  /** First up-to-4 poster URLs for the card mosaic (per-viewer). */
  posters: string[];
  /** Smart rules; null for a static playlist. */
  rules?: SmartRules | null;
  /** ISO timestamp of the last edit (rename, flag or item change). */
  updatedAt: string;
}

export interface PlaylistEpisode {
  id: number;
  episodeNumber: number;
  endEpisodeNumber?: number | null;
  title?: string | null;
  stillUrl?: string | null;
  runtime?: number | null;
  season?: { seasonNumber: number } | null;
}

/** The track of a music entry. */
export interface PlaylistTrack {
  /** The track's item id (the entry id is the row's `itemId`). */
  itemId: number;
  title: string;
  artists: string[];
  albumTitle: string;
  /** The album. */
  mediaId: number;
  posterUrl: string | null;
  durationSeconds: number | null;
  mediaFileId: number | null;
}

export interface PlaylistItem {
  /** The entry id on a static playlist (remove/reorder); the track item id on a smart one. */
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
  /** Set for a music entry. */
  track?: PlaylistTrack;
}

export interface M3uImportResult {
  playlist: Playlist;
  matched: number;
  unmatched: { line: number; text: string }[];
}

export interface CreatePlaylistBody {
  name: string;
  autoRemoveWatched?: boolean;
  autoPlay?: boolean;
  visibility?: PlaylistVisibility;
  rules?: SmartRules;
}

export type UpdatePlaylistBody = Partial<CreatePlaylistBody>;

/** Scope of an add: a movie/series (`mediaId`), a single `episodeId`, or a
 *  whole `seasonId`. Season/series expand to episodes server-side. */
export interface AddToPlaylistBody {
  mediaId?: number;
  episodeId?: number;
  seasonId?: number;
  /** A track of an album. */
  itemId?: number;
}

@Injectable({ providedIn: 'root' })
export class PlaylistsApiService {
  private readonly http = inject(HttpClient);
  private readonly serverVersion = inject(ServerVersionService);
  /** M3U import and export are newer than the oldest supported server; the entries that call them hide on an older one. */
  readonly m3uSupported = computed(() => this.serverVersion.supports(SERVER_SINCE.playlistM3u));
  readonly previewSupported = computed(() => this.serverVersion.supports(SERVER_SINCE.playlistPreview));

  list(opts: CacheRead = {}) {
    const headers = cacheHeaders(opts);
    return firstValueFrom(
      this.http.get<Playlist[]>('/api/playlists', headers ? { headers } : {}),
    );
  }

  get(id: number, opts: CacheRead = {}) {
    const headers = cacheHeaders(opts);
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

  items(id: number, opts: CacheRead = {}) {
    const headers = cacheHeaders(opts);
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

  /** Remove every item of one media (a series → all its episodes). */
  removeItemsByMedia(id: number, mediaId: number) {
    return firstValueFrom(
      this.http.delete<{ removed: number }>(
        `/api/playlists/${id}/items/by-media/${mediaId}`,
      ),
    );
  }

  /** Count of tracks the rules match for the caller. */
  async preview(rules: SmartRules): Promise<number> {
    return (await firstValueFrom(this.http.post<{ count: number }>('/api/playlists/preview', { rules }))).count;
  }

  importM3u(name: string, content: string) {
    return firstValueFrom(this.http.post<M3uImportResult>('/api/playlists/import-m3u', { name, content }));
  }

  /** The M3U8 file; the name comes from Content-Disposition, null when the header is hidden. */
  async exportM3u(id: number): Promise<{ blob: Blob; filename: string | null }> {
    const res = await firstValueFrom(
      this.http.get(`/api/playlists/${id}/export.m3u`, { responseType: 'blob', observe: 'response' }),
    );
    const cd = res.headers.get('Content-Disposition') ?? '';
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1];
    const plain = /filename="?([^";]+)"?/i.exec(cd)?.[1];
    return { blob: res.body as Blob, filename: star ? decodeURIComponent(star) : (plain ?? null) };
  }

  // ── Members (collaboration) ──

  members(id: number) {
    return firstValueFrom(
      this.http.get<PlaylistMember[]>(`/api/playlists/${id}/members`),
    );
  }

  addMember(id: number, userId: number, role: PlaylistShareRole) {
    return firstValueFrom(
      this.http.post<PlaylistMember[]>(`/api/playlists/${id}/members`, { userId, role }),
    );
  }

  removeMember(id: number, userId: number) {
    return firstValueFrom(
      this.http.delete<PlaylistMember[]>(`/api/playlists/${id}/members/${userId}`),
    );
  }

  // ── Save (bookmark another member's playlist) ──

  save(id: number) {
    return firstValueFrom(this.http.post<void>(`/api/playlists/${id}/save`, {}));
  }

  unsave(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/playlists/${id}/save`));
  }
}
