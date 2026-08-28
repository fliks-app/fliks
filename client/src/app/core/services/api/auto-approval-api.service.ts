import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

/**
 * Every set criterion must match; an unset one matches anything, so `{}`
 * auto-approves every request. `userIds` and `roleIds` are OR'd together.
 * Rules are OR'd: one match approves.
 */
export interface AutoApprovalCriteria {
  userIds?: number[];
  roleIds?: number[];
  mediaType?: 'movie' | 'series';
  libraryIds?: number[];
  genreIds?: number[];
  maxSeasons?: number;
  yearFrom?: number;
  yearTo?: number;
}

export interface AutoApprovalRule {
  id: number;
  name: string;
  enabled: boolean;
  criteria: AutoApprovalCriteria;
}

export interface CreateAutoApprovalRuleBody {
  name: string;
  enabled?: boolean;
  criteria: AutoApprovalCriteria;
}

@Injectable({ providedIn: 'root' })
export class AutoApprovalApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<AutoApprovalRule[]>('/api/auto-approval-rules'));
  }

  create(body: CreateAutoApprovalRuleBody) {
    return firstValueFrom(this.http.post<AutoApprovalRule>('/api/auto-approval-rules', body));
  }

  update(id: number, body: CreateAutoApprovalRuleBody) {
    return firstValueFrom(this.http.put<AutoApprovalRule>(`/api/auto-approval-rules/${id}`, body));
  }

  remove(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/auto-approval-rules/${id}`));
  }
}
