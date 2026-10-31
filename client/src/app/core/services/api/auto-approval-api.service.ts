import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { MediaType } from '../../enums/media-type.enum';

/** Every set criterion must match and an unset one matches anything (`{}` approves all); `userIds`/`roleIds` are OR'd, as are rules. */
export interface AutoApprovalCriteria {
  userIds?: number[];
  roleIds?: number[];
  mediaType?: MediaType;
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
