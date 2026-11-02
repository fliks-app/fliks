import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { MediaType } from '../../enums/media-type.enum';
import { CacheRead, cacheHeaders } from '../../interceptors/cache.interceptor';
import { KIND_REGISTRY } from '../../media-kinds';
import type { WantSpec } from './wants-api.service';

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
  | 'failed'
  | 'removed';

/** Whether the request adds a title to the library or asks to delete one that
 *  is already imported. Omitting `kind` on create defaults to an add request. */
export type RequestKind = 'add' | 'delete';

/** The kinds TMDB names: requested by `tmdbId`. */
export type VideoMediaType = Exclude<MediaType, 'book'>;

export interface CreateVideoRequestBody {
  mediaType: VideoMediaType;
  tmdbId: number;
  title: string;
  kind?: RequestKind;
  qualityProfileId?: number;
  languageProfileId?: number;
  libraryId?: number;
  /** One of the library's folders; omitted means its default one. */
  folderId?: number;
  seasons?: number[];
}

/** A book is the Open Library work it is, asked per edition (format and language). */
export interface CreateBookRequestBody {
  mediaType: 'book';
  externalId: string;
  title: string;
  wants: WantSpec[];
  libraryId?: number;
  folderId?: number;
}

export type CreateRequestBody = CreateVideoRequestBody | CreateBookRequestBody;

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
  /** Whether the library media is monitored: an approved request with monitored media shows as "monitored", not just "approved". */
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
  /** `null` for a book, which is named by `externalId`. */
  tmdbId: number | null;
  /** Books only: the Open Library work and the editions asked for. */
  provider?: string;
  externalId?: string;
  wants?: WantSpec[];
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

/** Aggregate active-request state for a title across all users (no requester identity); drives the "already requested" gate and the series season/profile-lock UI. */
export interface TitleRequestState {
  requested: boolean;
  wholeSeriesRequested: boolean;
  requestedSeasons: number[];
  profilesLocked: boolean;
  lockedQualityProfileId: number | null;
  lockedLanguageProfileId: number | null;
  /** Books only: the editions of the active requests. */
  requestedWants?: WantSpec[];
}

export interface ListRequestsParams {
  status?: FliksRequestStatus;
  kind?: RequestKind;
  userId?: number;
  /** Narrow to one title. Pass `mediaType` alongside it — TMDB ids are only
   *  unique within a namespace, so a movie and a series can share a number. */
  tmdbId?: number;
  mediaType?: MediaType;
  page?: number;
  limit?: number;
}

/** The add page of a request's title, for a request whose media is not in the library yet. */
export function requestAddLink(r: FliksRequestRow): (string | number)[] {
  const base = ['/add', KIND_REGISTRY[r.mediaType].providerSegment];
  return r.mediaType === 'book' ? [...base, r.provider ?? '', r.externalId ?? ''] : [...base, r.tmdbId ?? ''];
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

  list(params: ListRequestsParams = {}, opts: CacheRead = {}) {
    let httpParams = new HttpParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        httpParams = httpParams.set(key, String(value));
      }
    }
    const headers = cacheHeaders(opts);
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

  getBookTitleState(externalId: string) {
    const params = new HttpParams().set('mediaType', 'book').set('externalId', externalId);
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
