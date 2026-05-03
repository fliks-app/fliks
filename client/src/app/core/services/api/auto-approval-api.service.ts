import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface RuleCondition {
  field: 'role' | 'genre' | 'year' | 'seasons' | 'userId';
  operator: 'equals' | 'notEquals' | 'greaterThan' | 'lessThan' | 'contains';
  value: string | number;
}

export interface AutoApprovalRule {
  id: number;
  name: string;
  enabled: boolean;
  priority: number;
  conditions: RuleCondition[];
}

export interface CreateAutoApprovalRuleBody {
  name: string;
  enabled?: boolean;
  priority?: number;
  conditions: RuleCondition[];
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
