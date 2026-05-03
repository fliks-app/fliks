import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface RoleRow {
  id: number;
  name: string;
  permissions: string[];
  isDefault: boolean;
  defaultLibraryIds: number[];
}

export interface CreateRoleBody {
  name: string;
  permissions: string[];
  isDefault?: boolean;
  defaultLibraryIds?: number[];
}

export interface UpdateRoleBody {
  name?: string;
  permissions?: string[];
  isDefault?: boolean;
  defaultLibraryIds?: number[];
}

@Injectable({ providedIn: 'root' })
export class RolesApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<RoleRow[]>('/api/roles'));
  }

  get(id: number) {
    return firstValueFrom(this.http.get<RoleRow>(`/api/roles/${id}`));
  }

  getPermissions() {
    return firstValueFrom(this.http.get<string[]>('/api/roles/permissions'));
  }

  create(body: CreateRoleBody) {
    return firstValueFrom(this.http.post<RoleRow>('/api/roles', body));
  }

  update(id: number, body: UpdateRoleBody) {
    return firstValueFrom(this.http.put<RoleRow>(`/api/roles/${id}`, body));
  }

  remove(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/roles/${id}`));
  }
}
