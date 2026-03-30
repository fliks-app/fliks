import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface UserRow {
  id: number;
  username: string;
  role: 'admin' | 'user' | 'readonly';
  enabled: boolean;
  createdAt: string;
}

export interface UpdateUserBody {
  username?: string;
  password?: string;
  role?: 'admin' | 'user' | 'readonly';
  enabled?: boolean;
}

@Injectable({ providedIn: 'root' })
export class UsersApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<UserRow[]>('/api/users'));
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

  regenerateApiKey(id: number) {
    return firstValueFrom(
      this.http.post<{ apiKey: string }>(
        `/api/users/${id}/api-key/regenerate`,
        {},
      ),
    );
  }
}
