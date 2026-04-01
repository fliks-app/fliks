import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface SubtitleFileRow {
  id: number;
  mediaId: number;
  episodeId?: number;
  mediaFileId: number;
  language: string;
  forced: boolean;
  hearingImpaired: boolean;
  providerType: string;
  providerFileId: string;
  filePath: string;
  status: string;
  score: number;
  synced: boolean;
  syncOffset?: number;
}

export interface SubtitleSearchResult {
  providerFileId: string;
  title: string;
  language: string;
  forced: boolean;
  hearingImpaired: boolean;
  score: number;
  downloadCount?: number;
  providerName: string;
  providerType: string;
}

@Injectable({ providedIn: 'root' })
export class SubtitlesApiService {
  private readonly http = inject(HttpClient);

  getForMedia(mediaId: number) {
    return firstValueFrom(this.http.get<SubtitleFileRow[]>(`/api/media/${mediaId}/subtitles`));
  }

  search(mediaId: number, language?: string, episodeId?: number) {
    const params: Record<string, string> = {};
    if (language) params['language'] = language;
    if (episodeId != null) params['episodeId'] = String(episodeId);
    return firstValueFrom(
      this.http.get<SubtitleSearchResult[]>(`/api/media/${mediaId}/subtitles/search`, { params }),
    );
  }

  download(mediaId: number, body: { searchResult: SubtitleSearchResult; mediaFileId: number; episodeId?: number }) {
    return firstValueFrom(
      this.http.post<SubtitleFileRow>(`/api/media/${mediaId}/subtitles/download`, body),
    );
  }

  delete(mediaId: number, subtitleId: number) {
    return firstValueFrom(this.http.delete<void>(`/api/media/${mediaId}/subtitles/${subtitleId}`));
  }

  sync(mediaId: number, subtitleId: number) {
    return firstValueFrom(
      this.http.post<SubtitleFileRow>(`/api/media/${mediaId}/subtitles/${subtitleId}/sync`, {}),
    );
  }

  upgrade(mediaId: number, subtitleId: number, searchResult: SubtitleSearchResult) {
    return firstValueFrom(
      this.http.post<SubtitleFileRow>(`/api/media/${mediaId}/subtitles/${subtitleId}/upgrade`, { searchResult }),
    );
  }

  getHistory(params?: { page?: number; limit?: number; status?: string; language?: string; providerType?: string }) {
    return firstValueFrom(
      this.http.get<SubtitleHistoryResponse>('/api/subtitles/history', { params: params as any }),
    );
  }

  getStats() {
    return firstValueFrom(this.http.get<SubtitleStats>('/api/subtitles/stats'));
  }

  getHealth() {
    return firstValueFrom(
      this.http.get<SubtitleHealthEntry[]>('/api/subtitles/health'),
    );
  }
}

export interface SubtitleHistoryEntry {
  id: number;
  mediaId: number;
  mediaTitle: string;
  language: string;
  providerType: string;
  score: number;
  status: string;
  forced: boolean;
  hearingImpaired: boolean;
  synced: boolean;
  createdAt: string;
}

export interface SubtitleHistoryResponse {
  data: SubtitleHistoryEntry[];
  total: number;
  page: number;
  limit: number;
}

export interface SubtitleStats {
  total: number;
  byStatus: Record<string, number>;
  byProvider: Record<string, number>;
  recent: {
    id: number;
    mediaTitle: string;
    language: string;
    providerType: string;
    score: number;
    status: string;
    createdAt: string;
  }[];
}

export interface SubtitleHealthEntry {
  id: number;
  name: string;
  type: string;
  ok: boolean;
  error: string | null;
}
