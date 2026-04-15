import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class JellyseerrApiService {
  private readonly http = inject(HttpClient);

  testConnection(url: string, apiKey: string) {
    return firstValueFrom(
      this.http.post<{ ok: boolean; message: string }>(
        '/api/jellyseerr/test',
        { url, apiKey },
      ),
    );
  }

  importRequests() {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>(
        '/api/jellyseerr/import-requests',
        {},
      ),
    );
  }
}
