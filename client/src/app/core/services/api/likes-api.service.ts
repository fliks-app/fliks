import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { CACHE_BYPASS_HEADER } from '../../interceptors/cache.interceptor';

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
  mediaType: string;
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

  private headers(force?: boolean) {
    return force ? { headers: { [CACHE_BYPASS_HEADER]: '1' } } : {};
  }

  /** The caller's liked content, optionally scoped to a library. */
  mine(libraryId?: number, opts: { force?: boolean } = {}) {
    const params = libraryId ? { libraryId: String(libraryId) } : undefined;
    return firstValueFrom(
      this.http.get<LikedItem[]>('/api/likes', {
        ...(params ? { params } : {}),
        ...this.headers(opts.force),
      }),
    );
  }

  /** The caller's like state for a media (drives the detail-page hearts). */
  state(mediaId: number, opts: { force?: boolean } = {}) {
    return firstValueFrom(
      this.http.get<LikeState>(`/api/likes/state/${mediaId}`, this.headers(opts.force)),
    );
  }

  like(target: LikeTarget) {
    return firstValueFrom(this.http.post<void>('/api/likes', target));
  }

  unlike(target: LikeTarget) {
    return firstValueFrom(
      this.http.delete<void>('/api/likes', { body: target }),
    );
  }
}
