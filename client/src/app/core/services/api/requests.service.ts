import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { MediaType } from '../../enums/media-type.enum';
import { CACHE_BYPASS_HEADER } from '../../interceptors/cache.interceptor';

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

/** Whether the request adds a title to the library or asks to delete one that
 *  is already imported. Omitting `kind` on create defaults to an add request. */
export type RequestKind = 'add' | 'delete';

export interface CreateRequestBody {
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  kind?: RequestKind;
  qualityProfileId?: number;
  languageProfileId?: number;
  libraryId?: number;
  seasons?: number[];
}

export interface UpdateRequestBody {
  qualityProfileId?: number;
  languageProfileId?: number;
  /** `null` clears the target library (falls back to the type default at
   *  approval); omit to leave it unchanged. */
  libraryId?: number | null;
}

export interface RequestMedia {
  id: number;
  title: string;
  year: number | null;
  /** Whether the library media is monitored — an approved request whose media
   *  is monitored is being worked on (shown as "monitored" rather than just
   *  "approved"). */
  monitored?: boolean;
  /** Local `/api/images` paths of the imported media — secondary art source
   *  for requests created before local request art existed. */
  posterUrl: string | null;
  fanartUrl: string | null;
}

export interface FliksRequestRow {
  id: number;
  userId: number;
  user: RequestUser;
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  status: FliksRequestStatus;
  /** Discriminates an add request from a deletion request. A delete request's
   *  APPROVED status is terminal (the media was deleted at approval). */
  kind: RequestKind;
  approvedById: number | null;
  approvedBy: RequestUser | null;
  declinedReason: string | null;
  qualityProfileId: number | null;
  languageProfileId: number | null;
  libraryId: number | null;
  mediaId: number | null;
  /** Joined media row when linked. Use `media?.title` to display the live
   *  title (the cached `title` field may be stale or empty). */
  media: RequestMedia | null;
  seasons: number[] | null;
  /** Local card art (`/api/images/request/...`) stored at creation; null on
   *  requests that predate local request art (metadata fallback applies). */
  posterUrl: string | null;
  fanartUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RequestsPage {
  data: FliksRequestRow[];
  total: number;
}

/** Aggregate active-request state for a title, across all users (no
 *  requester identity). Drives the global "already requested" gate and the
 *  series per-season + profile-lock UI. */
export interface TitleRequestState {
  requested: boolean;
  wholeSeriesRequested: boolean;
  requestedSeasons: number[];
  profilesLocked: boolean;
  lockedQualityProfileId: number | null;
  lockedLanguageProfileId: number | null;
}

export interface ListRequestsParams {
  status?: FliksRequestStatus;
  kind?: RequestKind;
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

  list(params: ListRequestsParams = {}, opts: { force?: boolean } = {}) {
    let httpParams = new HttpParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        httpParams = httpParams.set(key, String(value));
      }
    }
    const headers = opts.force ? { [CACHE_BYPASS_HEADER]: '1' } : undefined;
    return firstValueFrom(
      this.http.get<RequestsPage>(
        '/api/requests',
        headers ? { params: httpParams, headers } : { params: httpParams },
      ),
    );
  }

  getTitleState(tmdbId: number, mediaType: MediaType) {
    const params = new HttpParams()
      .set('tmdbId', String(tmdbId))
      .set('mediaType', mediaType);
    return firstValueFrom(
      this.http.get<TitleRequestState>('/api/requests/title-state', { params }),
    );
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
