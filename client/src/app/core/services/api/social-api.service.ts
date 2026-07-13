import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { CACHE_BYPASS_HEADER } from '../../interceptors/cache.interceptor';
import { ProfileVisibility } from '../auth.service';
import { Playlist } from './playlists-api.service';
import { RecommendationItem, WatchHistoryItem } from './streaming-api.service';

/** A member as seen by another, with caller-relative follow state. */
export interface SocialUser {
  id: number;
  username: string;
  avatar: string | null;
  isFollowing: boolean;
  requested: boolean;
  followsYou: boolean;
}

export interface PublicProfile extends SocialUser {
  isSelf: boolean;
  visibility: ProfileVisibility;
  followerCount: number;
  followingCount: number;
  shown: {
    playlists: boolean;
    tastes: boolean;
    recommendations: boolean;
    recentlyWatched: boolean;
  };
  playlists: Playlist[];
  topGenres: { genre: string; weight: number }[];
  recommendations: RecommendationItem[];
  recentlyWatched: WatchHistoryItem[];
}

type FollowResult = { status: 'pending' | 'accepted' };

@Injectable({ providedIn: 'root' })
export class SocialApiService {
  private readonly http = inject(HttpClient);

  private headers(force?: boolean) {
    return force ? { headers: { [CACHE_BYPASS_HEADER]: '1' } } : {};
  }

  searchUsers(q: string) {
    return firstValueFrom(
      this.http.get<SocialUser[]>('/api/social/search', {
        params: { q },
        ...this.headers(true),
      }),
    );
  }

  /** Members the caller may add as playlist collaborators (public or followed). */
  searchConnectable(q: string) {
    return firstValueFrom(
      this.http.get<SocialUser[]>('/api/social/connectable', {
        params: { q },
        ...this.headers(true),
      }),
    );
  }

  getProfile(userId: number, opts: { force?: boolean } = {}) {
    return firstValueFrom(
      this.http.get<PublicProfile>(
        `/api/social/users/${userId}/profile`,
        this.headers(opts.force),
      ),
    );
  }

  listFollowers(userId: number, opts: { force?: boolean } = {}) {
    return firstValueFrom(
      this.http.get<SocialUser[]>(
        `/api/social/users/${userId}/followers`,
        this.headers(opts.force),
      ),
    );
  }

  listFollowing(userId: number, opts: { force?: boolean } = {}) {
    return firstValueFrom(
      this.http.get<SocialUser[]>(
        `/api/social/users/${userId}/following`,
        this.headers(opts.force),
      ),
    );
  }

  listRequests(opts: { force?: boolean } = {}) {
    return firstValueFrom(
      this.http.get<SocialUser[]>('/api/social/requests', this.headers(opts.force)),
    );
  }

  follow(userId: number) {
    return firstValueFrom(
      this.http.post<FollowResult>(`/api/social/follow/${userId}`, {}),
    );
  }

  unfollow(userId: number) {
    return firstValueFrom(
      this.http.delete<void>(`/api/social/follow/${userId}`),
    );
  }

  acceptRequest(userId: number) {
    return firstValueFrom(
      this.http.post<void>(`/api/social/requests/${userId}/accept`, {}),
    );
  }

  rejectRequest(userId: number) {
    return firstValueFrom(
      this.http.post<void>(`/api/social/requests/${userId}/reject`, {}),
    );
  }
}
