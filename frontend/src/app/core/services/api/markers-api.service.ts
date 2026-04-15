import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export type MarkerType = 'intro' | 'outro' | 'recap';

export interface EpisodeMarker {
  id: number;
  episodeId: number;
  type: MarkerType;
  startSeconds: number;
  endSeconds: number;
  confidence: number;
  manual: boolean;
}

export interface CommandSummary {
  id: number;
  name: string;
  status: string;
}

@Injectable({ providedIn: 'root' })
export class MarkersApiService {
  private readonly http = inject(HttpClient);

  listForEpisode(episodeId: number) {
    return firstValueFrom(
      this.http.get<EpisodeMarker[]>(`/api/markers/episode/${episodeId}`),
    );
  }

  listForSeason(seasonId: number) {
    return firstValueFrom(
      this.http.get<EpisodeMarker[]>(`/api/markers/season/${seasonId}`),
    );
  }

  detectSeason(seasonId: number) {
    return firstValueFrom(
      this.http.post<CommandSummary>(
        `/api/markers/season/${seasonId}/detect`,
        {},
      ),
    );
  }

  detectSeries(mediaId: number) {
    return firstValueFrom(
      this.http.post<CommandSummary[]>(
        `/api/markers/series/${mediaId}/detect-all`,
        {},
      ),
    );
  }

  create(payload: {
    episodeId: number;
    type: MarkerType;
    startSeconds: number;
    endSeconds: number;
  }) {
    return firstValueFrom(
      this.http.post<EpisodeMarker>(`/api/markers`, payload),
    );
  }

  update(id: number, payload: { startSeconds?: number; endSeconds?: number }) {
    return firstValueFrom(
      this.http.put<EpisodeMarker>(`/api/markers/${id}`, payload),
    );
  }

  remove(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/markers/${id}`));
  }
}
