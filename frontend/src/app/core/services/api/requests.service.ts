import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { MediaType } from '../../enums/media-type.enum';

export interface RequestUser {
  id: number;
  username: string;
}

export type FliksRequestStatus =
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
  libraryId?: number;
  seasons?: number[];
}

export interface UpdateRequestBody {
  qualityProfileId?: number;
  languageProfileId?: number;
  libraryId?: number;
}

export interface FliksRequestRow {
  id: number;
  userId: number;
  user: RequestUser;
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  status: FliksRequestStatus;
  approvedById: number | null;
  approvedBy: RequestUser | null;
  declinedReason: string | null;
  qualityProfileId: number | null;
  languageProfileId: number | null;
  libraryId: number | null;
  mediaId: number | null;
  seasons: number[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface RequestsPage {
  data: FliksRequestRow[];
  total: number;
}

export interface ListRequestsParams {
  status?: FliksRequestStatus;
  userId?: number;
  page?: number;
  limit?: number;
}

@Injectable({ providedIn: 'root' })
export class RequestsService {
  private readonly http = inject(HttpClient);

  create(body: CreateRequestBody) {
    return firstValueFrom(this.http.post<FliksRequestRow>('/api/requests', body));
  }

  update(id: number, body: UpdateRequestBody) {
    return firstValueFrom(this.http.patch<FliksRequestRow>(`/api/requests/${id}`, body));
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
    return firstValueFrom(this.http.post<FliksRequestRow>(`/api/requests/${id}/approve`, {}));
  }

  decline(id: number, reason?: string) {
    return firstValueFrom(
      this.http.post<FliksRequestRow>(`/api/requests/${id}/decline`, {
        reason: reason?.trim() || undefined,
      }),
    );
  }
}
