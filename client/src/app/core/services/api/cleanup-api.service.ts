import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface CleanupCriteria {
  libraryIds?: number[];
  mediaType?: 'movie' | 'series';
  addedOlderThanDays?: number;
  releasedOlderThanDays?: number;
  lastPlayedOlderThanDays?: number;
  neverPlayed?: boolean;
  watchedByRequester?: boolean;
  ratingBelow?: number;
  minVotes?: number;
  sizeAboveGb?: number;
  genres?: string[];
  excludeGenres?: string[];
  seriesEnded?: boolean;
  notLiked?: boolean;
  likedByFewerThan?: number;
  notLikedByRequester?: boolean;
  diskFreeBelowPercent?: number;
}

export type CleanupAction = 'delete' | 'delete_files_unmonitor' | 'none';

export interface CleanupRule {
  id: number;
  createdAt: string;
  updatedAt: string;
  name: string;
  enabled: boolean;
  criteria: CleanupCriteria;
  action: CleanupAction;
  graceDays: number | null;
}

export type CleanupRuleBody = Pick<CleanupRule, 'name' | 'enabled' | 'criteria' | 'action' | 'graceDays'>;

export interface CleanupPreview {
  matches: { id: number; title: string; type: string; size: number; lastPlayedAt: string | null }[];
  totalSize: number;
}

export interface CleanupCandidate {
  mediaId: number;
  title: string;
  type: string;
  posterUrl: string | null;
  ruleId: number;
  ruleName: string;
  action: CleanupAction;
  size: number;
  flaggedAt: string;
  deleteAt: string | null;
}

@Injectable({ providedIn: 'root' })
export class CleanupApiService {
  private readonly http = inject(HttpClient);

  listRules() {
    return firstValueFrom(this.http.get<CleanupRule[]>('/api/cleanup/rules'));
  }

  createRule(body: CleanupRuleBody) {
    return firstValueFrom(this.http.post<CleanupRule>('/api/cleanup/rules', body));
  }

  updateRule(id: number, body: CleanupRuleBody) {
    return firstValueFrom(this.http.put<CleanupRule>(`/api/cleanup/rules/${id}`, body));
  }

  removeRule(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/cleanup/rules/${id}`));
  }

  preview(id: number) {
    return firstValueFrom(this.http.post<CleanupPreview>(`/api/cleanup/rules/${id}/preview`, {}));
  }

  candidates() {
    return firstValueFrom(this.http.get<CleanupCandidate[]>('/api/cleanup/candidates'));
  }

  deleteNow(mediaId: number) {
    return firstValueFrom(this.http.post<{ ok: boolean }>(`/api/cleanup/candidates/${mediaId}/delete-now`, {}));
  }

  keep(mediaId: number) {
    return firstValueFrom(this.http.post<void>(`/api/cleanup/exclusions/${mediaId}`, {}));
  }
}
