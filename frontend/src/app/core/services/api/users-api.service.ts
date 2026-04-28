import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface UserRow {
  id: number;
  username: string;
  roleId: number | null;
  role: string | null;
  isAdmin: boolean;
  enabled: boolean;
  requirePasswordChange: boolean;
  createdAt: string;
  lastLogin: string | null;
  libraryIds: number[];
}

export interface CreateUserBody {
  username: string;
  password: string;
  email?: string;
  roleId?: number;
  enabled?: boolean;
  libraryIds?: number[];
}

export interface UpdateUserBody {
  username?: string;
  password?: string;
  roleId?: number;
  isAdmin?: boolean;
  enabled?: boolean;
  requirePasswordChange?: boolean;
  libraryIds?: number[];
}

/** Aggregated stats payload for the admin user-detail Statistics tab. */
export interface UserStats {
  playback: {
    totalWatchTimeSeconds: number;
    moviesWatched: number;
    seriesStarted: number;
    episodesWatched: number;
    lastPlayedAt: string | null;
  };
  requests: {
    pending: number;
    approved: number;
    declined: number;
  };
  activity: {
    lastActiveAt: string | null;
    memberSince: string;
  };
}

@Injectable({ providedIn: 'root' })
export class UsersApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<UserRow[]>('/api/users'));
  }

  getStats(id: number) {
    return firstValueFrom(this.http.get<UserStats>(`/api/users/${id}/stats`));
  }

  create(body: CreateUserBody) {
    return firstValueFrom(this.http.post<UserRow>('/api/users', body));
  }

  get(id: number) {
    return firstValueFrom(this.http.get<UserRow>(`/api/users/${id}`));
  }

  update(id: number, body: UpdateUserBody) {
    return firstValueFrom(this.http.put<UserRow>(`/api/users/${id}`, body));
  }

  remove(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/users/${id}`));
  }

}
