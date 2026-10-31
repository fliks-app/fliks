import type { MediaType } from '../../enums/media-type.enum';
import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { CacheRead, cacheHeaders } from '../../interceptors/cache.interceptor';

/** Identifies liked content: movie (mediaId), season (+seasonId), episode (+episodeId). */
export interface LikeTarget {
  mediaId: number;
  seasonId?: number;
  episodeId?: number;
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
  /** Bumped after every like/unlike, so a view kept alive elsewhere (a cached
   *  detail page under a notification's heart) can refetch its state. */
  readonly changed = signal<{ mediaId: number } | null>(null);

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
    this.changed.set({ mediaId: target.mediaId });
  }

  async unlike(target: LikeTarget) {
    await firstValueFrom(this.http.delete<void>('/api/likes', { body: target }));
    this.changed.set({ mediaId: target.mediaId });
  }
}
