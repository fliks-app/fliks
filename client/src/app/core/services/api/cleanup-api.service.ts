import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface CleanupCriteria {
  libraryIds?: number[];
  excludeLibraryIds?: number[];
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
  playCountBelow?: number;
  playCountByUsersBelow?: number;
  notPlayedInLastDays?: number;
  likedByFewerThan?: number;
  notLikedByRequester?: boolean;
  keepLatestEpisodes?: number;
  diskFreeBelowPercent?: number;
}

export type CleanupLevel = 'movie' | 'series' | 'season' | 'episode';

export type CleanupAction = 'delete' | 'delete_files_unmonitor' | 'none';

export interface CleanupRule {
  id: number;
  createdAt: string;
  updatedAt: string;
  name: string;
  enabled: boolean;
  levels: CleanupLevel[];
  criteria: CleanupCriteria;
  action: CleanupAction;
  graceDays: number | null;
  deleteSeriesWhenEmpty: boolean;
  reminderDays: number[];
}

export type CleanupRuleBody = Pick<
  CleanupRule,
  'name' | 'enabled' | 'levels' | 'criteria' | 'action' | 'graceDays' | 'deleteSeriesWhenEmpty' | 'reminderDays'
>;

/** The season and episode of a candidate; both null for a whole media. */
export interface CleanupScope {
  seasonId: number | null;
  episodeId: number | null;
}

export interface CleanupPreview {
  matches: (CleanupScope & {
    id: number;
    title: string;
    type: string;
    size: number;
    lastPlayedAt: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
  })[];
  totalSize: number;
}

export interface CleanupCandidate extends CleanupScope {
  id: number;
  mediaId: number;
  seasonNumber: number | null;
  episodeNumber: number | null;
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

export type CleanupReason = 'never_played' | 'watched_by_requester' | 'not_played_for_a_year' | 'series_ended';

export interface CleanupRecommendations {
  /** The built-in sets, so a reason can be turned into a rule. */
  reasons: { key: CleanupReason; criteria: CleanupCriteria; levels: CleanupLevel[] }[];
  items: {
    mediaId: number;
    title: string;
    type: string;
    size: number;
    lastPlayedAt: string | null;
    reasons: CleanupReason[];
  }[];
}

function scopeParams(c: CleanupScope): Record<string, number> {
  return {
    ...(c.seasonId != null && { seasonId: c.seasonId }),
    ...(c.episodeId != null && { episodeId: c.episodeId }),
  };
}

export interface CleanupBulkResult {
  results: (CleanupScope & { mediaId: number; ok: boolean; error?: string })[];
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

  recommendations() {
    return firstValueFrom(this.http.get<CleanupRecommendations>('/api/cleanup/recommendations'));
  }

  keepMedia(mediaId: number) {
    return firstValueFrom(this.http.post<void>(`/api/cleanup/exclusions/${mediaId}`, {}));
  }

  deleteNow(c: CleanupCandidate) {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>(`/api/cleanup/candidates/${c.mediaId}/delete-now`, {}, { params: scopeParams(c) }),
    );
  }

  keep(c: CleanupCandidate) {
    return firstValueFrom(this.http.post<void>(`/api/cleanup/exclusions/${c.mediaId}`, {}, { params: scopeParams(c) }));
  }

  exportRule(id: number) {
    return firstValueFrom(this.http.get<unknown>(`/api/cleanup/rules/${id}/export`));
  }

  importRule(body: unknown) {
    return firstValueFrom(this.http.post<CleanupRule>('/api/cleanup/rules/import', body));
  }

  bulk(action: 'keep' | 'delete-now', candidates: CleanupCandidate[]) {
    const items = candidates.map((c) => ({ mediaId: c.mediaId, ...scopeParams(c) }));
    return firstValueFrom(this.http.post<CleanupBulkResult>('/api/cleanup/candidates/bulk', { action, items }));
  }
}
