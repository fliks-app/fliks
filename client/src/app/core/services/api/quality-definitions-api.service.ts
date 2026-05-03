import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

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

  getAll(): Promise<QualityDefinition[]> {
    return firstValueFrom(this.http.get<QualityDefinition[]>('/api/quality-definitions'));
  }

  getDefaults(): Promise<QualityDefinition[]> {
    return firstValueFrom(this.http.post<QualityDefinition[]>('/api/quality-definitions/reset', {}));
  }

  updateAll(items: { qualityId: number; title: string; minSize: number; preferredSize: number; maxSize: number }[]): Promise<QualityDefinition[]> {
    return firstValueFrom(this.http.put<QualityDefinition[]>('/api/quality-definitions', { items }));
  }
}
