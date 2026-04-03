import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { MediaType } from '../../enums/media-type.enum';

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

export interface CreateRequestBody {
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  qualityProfileId?: number;
  languageProfileId?: number;
  rootFolderId?: number;
  seasons?: number[];
}

export interface UpdateRequestBody {
  qualityProfileId?: number;
  languageProfileId?: number;
  rootFolderId?: number;
}

export interface SuitarrRequestRow {
  id: number;
  userId: number;
  user: RequestUser;
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  status: SuitarrRequestStatus;
  approvedById: number | null;
  approvedBy: RequestUser | null;
  declinedReason: string | null;
  qualityProfileId: number | null;
  languageProfileId: number | null;
  rootFolderId: number | null;
  mediaId: number | null;
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
  userId?: number;
  page?: number;
  limit?: number;
}

@Injectable({ providedIn: 'root' })
export class RequestsService {
  private readonly http = inject(HttpClient);

  create(body: CreateRequestBody) {
    return firstValueFrom(this.http.post<SuitarrRequestRow>('/api/requests', body));
  }

  update(id: number, body: UpdateRequestBody) {
    return firstValueFrom(this.http.patch<SuitarrRequestRow>(`/api/requests/${id}`, body));
  }

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
