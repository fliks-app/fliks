import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { CACHE_BYPASS_HEADER } from '../../interceptors/cache.interceptor';
import { ProfileVisibility } from '../auth.service';
import { Playlist } from './playlists-api.service';
import { RecommendationItem, WatchHistoryItem } from './streaming-api.service';
import { LikedItem } from './likes-api.service';
import { UserStats } from './users-api.service';

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
    likes: boolean;
    stats: boolean;
  };
  playlists: Playlist[];
  topGenres: { genre: string; weight: number }[];
  recommendations: RecommendationItem[];
  recentlyWatched: WatchHistoryItem[];
  likes: LikedItem[];
}

type FollowResult = { status: 'pending' | 'accepted' };

/** Identifies the content being recommended to another member. */
export interface RecommendContentBody {
  recipientId: number;
  mediaId: number;
  seasonId?: number;
  episodeId?: number;
  message?: string;
}

/** The content half of a recommendation card (movie / season / episode). */
export interface RecommendationCard {
  id: number;
  message: string | null;
  createdAt: string;
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

/** A content recommendation received from another member. */
export interface ReceivedRecommendation extends RecommendationCard {
  sender: { id: number; username: string; avatar: string | null };
  liked: boolean;
}

/** A content recommendation the caller sent to another member. */
export interface SentRecommendation extends RecommendationCard {
  recipient: { id: number; username: string; avatar: string | null };
}

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

  /** Media popular among the members the caller follows, for a library's
   *  Suggestions view. */
  followingRecommendations(libraryId: number, opts: { force?: boolean } = {}) {
    return firstValueFrom(
      this.http.get<RecommendationItem[]>('/api/social/recommendations', {
        params: { libraryId: String(libraryId) },
        ...this.headers(opts.force),
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

  /** Activity statistics for a profile's Statistics tab (owner, or a member who
   *  shares stats and whose profile the caller may see). */
  getUserStats(userId: number, opts: { force?: boolean } = {}) {
    return firstValueFrom(
      this.http.get<UserStats>(
        `/api/social/users/${userId}/stats`,
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

  // ── content recommendations (member → member) ──

  recommend(body: RecommendContentBody) {
    return firstValueFrom(this.http.post<void>('/api/social/recommend', body));
  }

  /** Content other members have recommended to me. Active feed by default;
   *  `includeDismissed` returns the full history (for the profile page). */
  receivedRecommendations(opts: { force?: boolean; includeDismissed?: boolean } = {}) {
    return firstValueFrom(
      this.http.get<ReceivedRecommendation[]>('/api/social/recommendations/received', {
        ...(opts.includeDismissed ? { params: { includeDismissed: 'true' } } : {}),
        ...this.headers(opts.force),
      }),
    );
  }

  /** Content I have recommended to other members. */
  sentRecommendations(opts: { force?: boolean } = {}) {
    return firstValueFrom(
      this.http.get<SentRecommendation[]>(
        '/api/social/recommendations/sent',
        this.headers(opts.force),
      ),
    );
  }

  dismissRecommendation(id: number) {
    return firstValueFrom(
      this.http.post<void>(`/api/social/recommendations/${id}/dismiss`, {}),
    );
  }
}
