import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { MediaType } from '../../enums/media-type.enum';

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
  /** Relative to media folder (same idea as video MediaFile.relativePath) */
  relativePath?: string | null;
  status: string;
  score: number;
  synced: boolean;
  syncOffset?: number;
  streamIndex?: number | null;
  codec?: string | null;
  /** For TRANSLATED subs: the provider name/engine/model that produced them. */
  translationProviderName?: string | null;
  translationEngine?: string | null;
  translationModel?: string | null;
  translationProviderId?: number | null;
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

  getStreams(mediaId: number, mediaFileId: number) {
    return firstValueFrom(
      this.http.get<MediaStream[]>(`/api/media/${mediaId}/streams/${mediaFileId}`),
    );
  }

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

  autoDownload(mediaId: number, body: { mediaFileId: number; episodeId?: number; language?: string }) {
    return firstValueFrom(
      this.http.post<SubtitleFileRow | null>(`/api/media/${mediaId}/subtitles/auto`, body),
    );
  }

  searchMissing(mediaId: number, body: { mediaFileId: number }) {
    return firstValueFrom(
      this.http.post<{ downloaded: string[] }>(
        `/api/media/${mediaId}/subtitles/search-missing`,
        body,
      ),
    );
  }

  ocr(mediaId: number, subtitleId: number, language?: string) {
    return firstValueFrom(
      this.http.post<SubtitleFileRow | null>(
        `/api/media/${mediaId}/subtitles/${subtitleId}/ocr`,
        language ? { language } : {},
      ),
    );
  }

  translate(
    mediaId: number,
    subtitleId: number,
    targetLanguage: string,
    providerId?: number,
  ) {
    return firstValueFrom(
      this.http.post<SubtitleFileRow | null>(
        `/api/media/${mediaId}/subtitles/${subtitleId}/translate`,
        { targetLanguage, ...(providerId != null ? { providerId } : {}) },
      ),
    );
  }

  validate(mediaId: number, subtitleId: number) {
    return firstValueFrom(
      this.http.post<SubtitleFileRow>(
        `/api/media/${mediaId}/subtitles/${subtitleId}/validate`,
        {},
      ),
    );
  }

  setLanguage(mediaId: number, subtitleId: number, language: string) {
    return firstValueFrom(
      this.http.patch<SubtitleFileRow>(
        `/api/media/${mediaId}/subtitles/${subtitleId}/language`,
        { language },
      ),
    );
  }

  download(mediaId: number, body: { searchResult: SubtitleSearchResult; mediaFileId: number; episodeId?: number }) {
    return firstValueFrom(
      this.http.post<SubtitleFileRow>(`/api/media/${mediaId}/subtitles/download`, body),
    );
  }

  /** Upload a subtitle file picked on the device. */
  upload(
    mediaId: number,
    file: File,
    body: { mediaFileId: number; episodeId?: number; language: string },
  ) {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('mediaFileId', String(body.mediaFileId));
    form.append('language', body.language);
    if (body.episodeId != null) form.append('episodeId', String(body.episodeId));
    return firstValueFrom(
      this.http.post<SubtitleFileRow>(`/api/media/${mediaId}/subtitles/upload`, form),
    );
  }

  delete(mediaId: number, subtitleId: number) {
    return firstValueFrom(this.http.delete<void>(`/api/media/${mediaId}/subtitles/${subtitleId}`));
  }

  sync(mediaId: number, subtitleId: number, options?: SyncOptions) {
    return firstValueFrom(
      this.http.post<SyncQueueItem>(`/api/media/${mediaId}/subtitles/${subtitleId}/sync`, options ?? {}),
    );
  }

  getSyncQueue() {
    return firstValueFrom(
      this.http.get<SyncQueueItem[]>('/api/media/sync-queue'),
    );
  }

  postProcess(mediaId: number, subtitleId: number, action: string, params?: Record<string, unknown>) {
    return firstValueFrom(
      this.http.post<SubtitleFileRow>(`/api/media/${mediaId}/subtitles/${subtitleId}/post-process`, { action, params }),
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

  // Blacklist
  getBlacklist(params?: { page?: number; limit?: number }) {
    return firstValueFrom(
      this.http.get<{ data: SubtitleBlacklistEntry[]; total: number }>('/api/subtitles/blacklist', { params: params as any }),
    );
  }

  addToBlacklist(dto: { providerType: string; providerFileId: string; mediaId?: number; language?: string; sourceTitle?: string; reason?: string }) {
    return firstValueFrom(
      this.http.post<SubtitleBlacklistEntry>('/api/subtitles/blacklist', dto),
    );
  }

  removeFromBlacklist(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/subtitles/blacklist/${id}`));
  }

  clearBlacklist() {
    return firstValueFrom(this.http.delete<{ deleted: number }>('/api/subtitles/blacklist'));
  }

  getMissing() {
    return firstValueFrom(this.http.get<MissingSubtitleEntry[]>('/api/subtitles/missing'));
  }
}

export interface SubtitleHistoryEntry {
  id: number;
  mediaId: number;
  mediaTitle: string;
  mediaType: MediaType | null;
  episodeId: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
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
    mediaId: number;
    mediaTitle: string;
    episodeId: number | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    episodeTitle: string | null;
    language: string;
    providerType: string;
    score: number;
    status: string;
    createdAt: string;
  }[];
}

export interface MediaStream {
  streamIndex: number;
  type: 'audio' | 'subtitle';
  codec: string;
  language: string;
  title?: string;
}

export interface SyncOptions {
  reference?: string;
  maxOffsetSeconds?: number;
  noFixFramerate?: boolean;
  goldenSectionSearch?: boolean;
}

export interface SyncQueueItem {
  subtitleId: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  error?: string;
  queuedAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface SubtitleBlacklistEntry {
  id: number;
  providerType: string;
  providerFileId: string;
  mediaId: number | null;
  language: string | null;
  sourceTitle: string | null;
  reason: string | null;
  createdAt: string;
}

export interface SubtitleHealthEntry {
  id: number;
  name: string;
  type: string;
  ok: boolean;
  error: string | null;
}

export interface MissingSubtitleEntry {
  mediaId: number;
  mediaTitle: string;
  mediaType: string;
  fileId: number;
  fileName: string;
  episodeId: number | null;
  episodeLabel: string | null;
  language: string;
}
