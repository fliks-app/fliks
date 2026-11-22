import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export type MarkerType = 'intro' | 'outro';

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

  detectSeries(mediaId: number) {
    return firstValueFrom(
      this.http.post<CommandSummary[]>(
        `/api/markers/series/${mediaId}/detect-all`,
        {},
      ),
    );
  }
}
