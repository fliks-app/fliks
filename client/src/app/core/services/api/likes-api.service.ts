import type { MediaType } from '../../enums/media-type.enum';
import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { CacheRead, cacheHeaders } from '../../interceptors/cache.interceptor';
import { SseService } from '../sse.service';

/** Identifies liked content: movie (mediaId), season (+seasonId), episode (+episodeId), track (+itemId). */
export interface LikeTarget {
  mediaId: number;
  seasonId?: number;
  episodeId?: number;
  itemId?: number;
}

/** A like added or removed on this device or another one; the ids repeat the like's granularity. */
export interface LikeChange {
  mediaId: number;
  seasonId?: number;
  itemId?: number;
  liked: boolean;
}

/** The caller's likes on one media. */
export interface LikeState {
  media: boolean;
  seasonIds: number[];
  episodeIds: number[];
}

/** A liked entry rendered as a card. */
export interface LikedItem {
  mediaId: number;
  mediaType: MediaType;
  title: string;
  posterUrl: string | null;
  fanartUrl: string | null;
  seasonId: number | null;
  episodeId: number | null;
  label: string | null;
  stillUrl: string | null;
}

@Injectable({ providedIn: 'root' })
export class LikesApiService {
  private readonly http = inject(HttpClient);
  /** The last like change, local or from another device: the one source a view kept alive elsewhere
   *  (a cached detail page, a notification's heart) follows to refetch its state. */
  readonly changed = signal<LikeChange | null>(null);

  constructor() {
    inject(SseService).likeEvents.subscribe(({ type: _type, ...change }) => this.changed.set(change));
  }

  private headers(opts: CacheRead) {
    const headers = cacheHeaders(opts);
    return headers ? { headers } : {};
  }

  /** The caller's liked content, optionally scoped to a library. */
  mine(libraryId?: number, opts: CacheRead = {}) {
    const params = libraryId ? { libraryId: String(libraryId) } : undefined;
    return firstValueFrom(
      this.http.get<LikedItem[]>('/api/likes', {
        ...(params ? { params } : {}),
        ...this.headers(opts),
      }),
    );
  }

  /** The caller's like state for a media (drives the detail-page hearts). */
  state(mediaId: number, opts: CacheRead = {}) {
    return firstValueFrom(
      this.http.get<LikeState>(`/api/likes/state/${mediaId}`, this.headers(opts)),
    );
  }

  async like(target: LikeTarget) {
    await firstValueFrom(this.http.post<void>('/api/likes', target));
    this.changed.set(changeOf(target, true));
  }

  async unlike(target: LikeTarget) {
    await firstValueFrom(this.http.delete<void>('/api/likes', { body: target }));
    this.changed.set(changeOf(target, false));
  }
}

function changeOf(t: LikeTarget, liked: boolean): LikeChange {
  const itemId = t.episodeId ?? t.itemId;
  return { mediaId: t.mediaId, ...(t.seasonId && { seasonId: t.seasonId }), ...(itemId && { itemId }), liked };
}
