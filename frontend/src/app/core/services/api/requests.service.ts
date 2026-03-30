import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface RequestUser {
  id: number;
  username: string;
}

export type SuitarrRequestStatus =
  | 'pending'
  | 'approved'
  | 'declined'
  | 'processing'
  | 'available'
  | 'failed';

export interface SuitarrRequestRow {
  id: number;
  userId: number;
  user: RequestUser;
  mediaType: 'movie' | 'series';
  tmdbId: number;
  title: string;
  status: SuitarrRequestStatus;
  approvedById: number | null;
  approvedBy: RequestUser | null;
  declinedReason: string | null;
  qualityProfileId: number | null;
  rootFolder: string | null;
  seasons: number[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface RequestsPage {
  data: SuitarrRequestRow[];
  total: number;
}

export interface ListRequestsParams {
  status?: SuitarrRequestStatus;
  page?: number;
  limit?: number;
}

@Injectable({ providedIn: 'root' })
export class RequestsService {
  private readonly http = inject(HttpClient);

  list(params: ListRequestsParams = {}) {
    let httpParams = new HttpParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        httpParams = httpParams.set(key, String(value));
      }
    }
    return firstValueFrom(this.http.get<RequestsPage>('/api/requests', { params: httpParams }));
  }

  remove(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/requests/${id}`));
  }

  approve(id: number) {
    return firstValueFrom(this.http.post<SuitarrRequestRow>(`/api/requests/${id}/approve`, {}));
  }

  decline(id: number, reason?: string) {
    return firstValueFrom(
      this.http.post<SuitarrRequestRow>(`/api/requests/${id}/decline`, {
        reason: reason?.trim() || undefined,
      }),
    );
  }
}
