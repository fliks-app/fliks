import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface RemotePathMapping {
  id: number;
  downloadClientId?: number;
  remotePath: string;
  localPath: string;
}

@Injectable({ providedIn: 'root' })
export class RemotePathMappingsApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(
      this.http.get<RemotePathMapping[]>('/api/settings/remote-path-mappings'),
    );
  }

  create(dto: Omit<RemotePathMapping, 'id'>) {
    return firstValueFrom(
      this.http.post<RemotePathMapping>('/api/settings/remote-path-mappings', dto),
    );
  }

  remove(id: number) {
    return firstValueFrom(
      this.http.delete<void>(`/api/settings/remote-path-mappings/${id}`),
    );
  }
}
