import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { LyricsResponse, LyricsSingers, LyricsWrite } from './lyrics.models';

@Injectable({ providedIn: 'root' })
export class LyricsApiService {
  private readonly http = inject(HttpClient);

  get(itemId: number): Promise<LyricsResponse> {
    return firstValueFrom(this.http.get<LyricsResponse>(`/api/items/${itemId}/lyrics`, { params: { enhanced: true } }));
  }

  put(itemId: number, body: LyricsWrite): Promise<void> {
    return firstValueFrom(this.http.put<void>(`/api/items/${itemId}/lyrics`, body));
  }

  patch(id: number, body: { preferred?: boolean; reviewed?: boolean } & Partial<LyricsSingers>): Promise<void> {
    return firstValueFrom(this.http.patch<void>(`/api/lyrics/${id}`, body));
  }

  remove(id: number): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/lyrics/${id}`));
  }

  fetch(itemId: number, force = false): Promise<LyricsResponse> {
    return firstValueFrom(this.http.post<LyricsResponse>(`/api/items/${itemId}/lyrics/fetch`, { force }));
  }
}
