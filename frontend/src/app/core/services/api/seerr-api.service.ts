import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class SeerrApiService {
  private readonly http = inject(HttpClient);

  testConnection(url: string, apiKey: string) {
    return firstValueFrom(
      this.http.post<{ ok: boolean; message: string }>(
        '/api/imports/seerr/test',
        { url, apiKey },
      ),
    );
  }

  importRequests() {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>(
        '/api/imports/seerr/import-requests',
        {},
      ),
    );
  }
}
