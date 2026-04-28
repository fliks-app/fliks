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

@Injectable({ providedIn: 'root' })
export class UsersApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<UserRow[]>('/api/users'));
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
