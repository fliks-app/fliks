import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface QualityProfile {
  id: number;
  name: string;
  cutoff: number;
  upgradeAllowed: boolean;
  items: {
    quality: { id: number; name: string; resolution: number; source: string };
    allowed: boolean;
    sortOrder: number;
  }[];
}

export interface CreateQualityProfilePayload {
  name: string;
  cutoff: number;
  upgradeAllowed?: boolean;
  items: {
    qualityId: number;
    qualityName: string;
    resolution: number;
    source: string;
    allowed: boolean;
    sortOrder: number;
  }[];
}

export interface LanguageProfile {
  id: number;
  name: string;
  cutoff: number;
  languages: {
    language: { id: number; name: string; isoCode: string };
    allowed: boolean;
    sortOrder: number;
  }[];
}

@Injectable({ providedIn: 'root' })
export class ProfilesService {
  private readonly http = inject(HttpClient);

  getQualityProfiles() {
    return firstValueFrom(this.http.get<QualityProfile[]>('/api/profiles/quality'));
  }

  getQualityProfile(id: number) {
    return firstValueFrom(this.http.get<QualityProfile>(`/api/profiles/quality/${id}`));
  }

  createQualityProfile(body: CreateQualityProfilePayload) {
    return firstValueFrom(this.http.post<QualityProfile>('/api/profiles/quality', body));
  }

  updateQualityProfile(id: number, body: CreateQualityProfilePayload) {
    return firstValueFrom(this.http.put<QualityProfile>(`/api/profiles/quality/${id}`, body));
  }

  deleteQualityProfile(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/profiles/quality/${id}`));
  }

  getLanguageProfiles() {
    return firstValueFrom(this.http.get<LanguageProfile[]>('/api/profiles/language'));
  }
}
