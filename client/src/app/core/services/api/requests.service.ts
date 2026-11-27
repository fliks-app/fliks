import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { MediaType } from '../../enums/media-type.enum';
import { SKIP_ERROR_TOAST } from '../../interceptors/error.interceptor';
import { CacheRead, cacheHeaders } from '../../interceptors/cache.interceptor';
import { kindOf } from '../../media-kinds';
import { AuthService } from '../auth.service';
import { SERVER_SINCE, ServerVersionService } from '../server-version.service';
import { StorageScopeService } from '../storage-scope.service';
import type { LastSearch } from './last-search.model';
import type { WantSpec } from './wants-api.service';

export interface RequestUser {
  id: number;
  username: string;
}

export const REQUEST_STATUSES = [
  'pending',
  'approved',
  'declined',
  'processing',
  'available',
  'failed',
  'removed',
] as const;
export type FliksRequestStatus = (typeof REQUEST_STATUSES)[number];

/** Whether the request adds a title to the library or asks to delete one that
 *  is already imported. Omitting `kind` on create defaults to an add request. */
export type RequestKind = 'add' | 'delete';

/** The kinds a video provider names. */
export type VideoMediaType = Exclude<MediaType, 'book'>;

/** A video title: its TMDB id when known, else the provider and id of the search result. */
export type TitleKey = { tmdbId: number } | { provider: string; externalId: string };

/** The `[provider, externalId]` a title key names. */
export function titleRef(key: TitleKey): [string, string] {
  return 'tmdbId' in key ? ['tmdb', String(key.tmdbId)] : [key.provider, key.externalId];
}

export type CreateVideoRequestBody = TitleKey & {
  mediaType: VideoMediaType;
  title: string;
  kind?: RequestKind;
  qualityProfileId?: number;
  languageProfileId?: number;
  libraryId?: number;
  /** One of the library's folders; omitted means its default one. */
  folderId?: number;
  seasons?: number[];
  /** Series only: follow the seasons that air later; omitted derives it from the scope. */
  monitorNewSeasons?: boolean;
};

/** A book is the Open Library work it is, asked per edition (format and language). */
export interface CreateBookRequestBody {
  mediaType: 'book';
  externalId: string;
  title: string;
  wants: WantSpec[];
  libraryId?: number;
  folderId?: number;
}

/** An album is the release group it is, asked with its audio want. */
export interface CreateAlbumRequestBody {
  mediaType: 'album';
  externalId: string;
  title: string;
  wants: WantSpec[];
  /** MusicBrainz recording ids: only those tracks are asked for; omitted asks the whole album. */
  recordings?: string[];
  libraryId?: number;
  folderId?: number;
}

export type CreateRequestBody = CreateVideoRequestBody | CreateBookRequestBody | CreateAlbumRequestBody;

export interface UpdateRequestBody {
  qualityProfileId?: number;
  languageProfileId?: number;
  /** `null` clears the target library (falls back to the type default at
   *  approval); omit to leave it unchanged. */
  libraryId?: number | null;
  /** Pending book requests only: replaces the wished editions. */
  wants?: WantSpec[];
  monitorNewSeasons?: boolean;
}

/** What a manager sets while approving; a series' profiles go to every active row of the title. */
export interface ApproveBody {
  qualityProfileId?: number;
  languageProfileId?: number;
  libraryId?: number;
  folderId?: number;
  monitorNewSeasons?: boolean;
  /** Widens a track request to the whole album. */
  wholeAlbum?: boolean;
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
  /** `null` for a book and for a title of another provider. */
  tmdbId: number | null;
  provider?: string;
  externalId?: string;
  /** Books only: the editions asked for. */
  wants?: WantSpec[];
  /** Albums only: the recordings asked for; null or absent is the whole album. */
  recordings?: string[] | null;
  /** Albums only: the tracks of the target edition. */
  trackCount?: number | null;
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
  /** Series only: what the requester chose for later seasons; null derives it at approval. */
  monitorNewSeasons?: boolean | null;
  /** Local card art (`/api/images/request/...`) stored at creation; null on
   *  requests that predate local request art (metadata fallback applies). */
  posterUrl: string | null;
  fanartUrl: string | null;
  createdAt: string;
  updatedAt: string;
  /** The last automatic search of the media; `null` is never searched. */
  lastSearch?: LastSearch | null;
}

/** An approved request still waiting for its file: the one the last search outcome explains. */
export const awaitsSearch = (r: FliksRequestRow): boolean => r.kind === 'add' && (r.status === 'approved' || r.status === 'processing');

/** An album request limited to some of its tracks. */
export const isTrackRequest = (r: FliksRequestRow): boolean => r.mediaType === 'album' && !!r.recordings?.length;

/** A member following a request, as a manager sees it. */
export interface RequestWatcher {
  id: number;
  username: string;
  avatar?: string | null;
  createdAt: string;
}

/** A request's detail; `watchers` is sent to managers only. */
/** A create's answer: the caller's row (or the earliest absorbed one) and the pending rows it approved. */
export interface CreatedRequest extends FliksRequestRow {
  absorbed: number[];
}

export interface FliksRequestDetail extends FliksRequestRow {
  watchers?: RequestWatcher[];
}

export interface RequestsPage {
  data: FliksRequestRow[];
  total: number;
}

/** A kind's request limit over its period; `nextFreeAt` is when the oldest counted request leaves the window. */
export interface KindAllowance {
  limit: number;
  used: number;
  periodDays: number;
  nextFreeAt: string | null;
}

/** Kinds without a limit are absent. */
export type RequestAllowance = Partial<Record<MediaType, KindAllowance>>;

/** Aggregate active-request state for a title across all users (no requester identity); drives the "already requested" gate and the series season/profile-lock UI. */
export interface TitleRequestState {
  requested: boolean;
  /** The caller follows the active request without owning it. */
  watching: boolean;
  /** Requester plus watchers; names stay private to non-managers. */
  requesterCount: number;
  requestedByMe: boolean;
  /** The active row behind `requested`. */
  requestId: number | null;
  /** The title's pending add rows, any requester, ascending. */
  pendingRequestIds: number[];
  wholeSeriesRequested: boolean;
  requestedSeasons: number[];
  profilesLocked: boolean;
  lockedQualityProfileId: number | null;
  lockedLanguageProfileId: number | null;
  /** Books only: the editions of the active requests. */
  requestedWants?: WantSpec[];
  /** Albums only: a request covers the whole album; `requestedRecordings` lists the tracks asked alone. */
  wholeAlbumRequested?: boolean;
  requestedRecordings?: string[];
}

export interface ListRequestsParams {
  status?: FliksRequestStatus;
  kind?: RequestKind;
  userId?: number;
  /** Narrow to one title. Pass `mediaType` alongside it — TMDB ids are only
   *  unique within a namespace, so a movie and a series can share a number. */
  tmdbId?: number;
  /** Another provider's id, given together with `externalId`. */
  provider?: string;
  externalId?: string;
  mediaType?: MediaType;
  page?: number;
  limit?: number;
}

/** The add page of a request's title, for a request whose media is not in the library yet. */
export function requestAddLink(r: FliksRequestRow): (string | number)[] {
  const base = ['/add', kindOf(r.mediaType).providerSegment];
  return [...base, r.provider ?? 'tmdb', r.externalId ?? r.tmdbId ?? ''];
}

const IMPORT_KINDS: ReadonlySet<MediaType> = new Set(['movie', 'series', 'book', 'album']);

@Injectable({ providedIn: 'root' })
export class RequestsService {
  private readonly http = inject(HttpClient);
  private readonly scope = inject(StorageScopeService);
  private readonly serverVersion = inject(ServerVersionService);
  private readonly auth = inject(AuthService);
  private readonly fetchedKinds = signal<ReadonlySet<MediaType>>(new Set());
  /** A server before it neither auto-approves adders nor takes `monitorNewSeasons` on a request. */
  private readonly requestAdds = computed(() => this.serverVersion.supports(SERVER_SINCE.autoApproval));
  /** An adder on an older server adds through the import routes. */
  readonly addsByImport = computed(() => !this.requestAdds() && this.auth.hasPermission('media.create'));
  readonly requestsFollowNewSeasons = this.requestAdds;
  /** The kinds whose add is certain to land at once for the caller: the one source of "Add" over "Request". */
  readonly autoKinds = computed<ReadonlySet<MediaType>>(() => (this.addsByImport() ? IMPORT_KINDS : this.fetchedKinds()));

  constructor() {
    effect(() => {
      this.scope.scope();
      untracked(() => void this.reloadAutoKinds());
    });
  }

  /** A hint: on failure, or on a server without the route, every add reads "Request". */
  async reloadAutoKinds(): Promise<void> {
    this.fetchedKinds.set(new Set(await this.fetchAutoKinds()));
  }

  private async fetchAutoKinds(): Promise<MediaType[]> {
    if (!(await this.serverVersion.supportsWhenKnown(SERVER_SINCE.autoApproval))) return [];
    const context = new HttpContext().set(SKIP_ERROR_TOAST, true);
    try {
      return (await firstValueFrom(this.http.get<{ kinds: MediaType[] }>('/api/requests/auto-approval', { context }))).kinds;
    } catch {
      return [];
    }
  }

  /** `skipToast`: the caller reports the failure itself. */
  create(body: CreateRequestBody, skipToast = false) {
    const context = skipToast ? new HttpContext().set(SKIP_ERROR_TOAST, true) : undefined;
    return firstValueFrom(this.http.post<CreatedRequest>('/api/requests', body, { context }));
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

  get(id: number) {
    return firstValueFrom(this.http.get<FliksRequestDetail>(`/api/requests/${id}`));
  }

  /** The caller reports a failure with its own toast, so the global one is skipped. */
  watch(id: number) {
    const context = new HttpContext().set(SKIP_ERROR_TOAST, true);
    return firstValueFrom(this.http.post<void>(`/api/requests/${id}/watch`, null, { context }));
  }

  unwatch(id: number) {
    const context = new HttpContext().set(SKIP_ERROR_TOAST, true);
    return firstValueFrom(this.http.delete<void>(`/api/requests/${id}/watch`, { context }));
  }

  /** Null when the caller may not request: the allowance is a hint, never an error. */
  async allowance(): Promise<RequestAllowance | null> {
    const context = new HttpContext().set(SKIP_ERROR_TOAST, true);
    try {
      return await firstValueFrom(this.http.get<RequestAllowance>('/api/requests/allowance', { context }));
    } catch {
      return null;
    }
  }

  getTitleState(key: TitleKey, mediaType: MediaType) {
    const [provider, externalId] = titleRef(key);
    const params = new HttpParams()
      .set('provider', provider)
      .set('externalId', externalId)
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

  approve(id: number, body: ApproveBody = {}, skipToast = false) {
    const context = skipToast ? new HttpContext().set(SKIP_ERROR_TOAST, true) : undefined;
    return firstValueFrom(this.http.post<FliksRequestRow>(`/api/requests/${id}/approve`, body, { context }));
  }

  decline(id: number, reason?: string) {
    return firstValueFrom(
      this.http.post<FliksRequestRow>(`/api/requests/${id}/decline`, {
        reason: reason?.trim() || undefined,
      }),
    );
  }
}
