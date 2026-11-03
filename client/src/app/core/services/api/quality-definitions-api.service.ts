import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { Family } from '../../enums/family.enum';

export interface QualityDefinition {
  id: number;
  qualityId: number;
  title: string;
  minSize: number;
  preferredSize: number;
  maxSize: number;
}

@Injectable({ providedIn: 'root' })
export class QualityDefinitionsApiService {
  private readonly http = inject(HttpClient);

  getAll(family: Family): Promise<QualityDefinition[]> {
    return firstValueFrom(
      this.http.get<QualityDefinition[]>('/api/quality-definitions', { params: { family } }),
    );
  }

  getDefaults(family: Family): Promise<QualityDefinition[]> {
    return firstValueFrom(
      this.http.post<QualityDefinition[]>('/api/quality-definitions/reset', {}, { params: { family } }),
    );
  }

  updateAll(
    family: Family,
    items: { qualityId: number; title: string; minSize: number; preferredSize: number; maxSize: number }[],
  ): Promise<QualityDefinition[]> {
    return firstValueFrom(
      this.http.put<QualityDefinition[]>('/api/quality-definitions', { items }, { params: { family } }),
    );
  }
}
