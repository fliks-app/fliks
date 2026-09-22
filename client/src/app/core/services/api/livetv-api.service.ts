import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SKIP_ERROR_TOAST } from '../../interceptors/error.interceptor';
import { ServerConfigService } from '../server-config.service';
import { AuthService } from '../auth.service';

export interface LiveChannel {
  id: number;
  name: string;
  number: number;
  logoPath: string | null;
  groupName: string | null;
  favorite: boolean;
  hidden: boolean;
  /** Present on guide responses; absent elsewhere. */
  guideChannelId?: string | null;
}

export interface LiveProgram {
  id: number;
  guideChannelId: string;
  startsAt: string;
  endsAt: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  categories: string[];
  iconUrl: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  isNew: boolean;
  isLive: boolean;
  rating: string | null;
  year: number | null;
}

export interface OnNowEntry {
  channel: LiveChannel;
  now: LiveProgram | null;
  next: LiveProgram | null;
}

export interface OnNowPage {
  entries: OnNowEntry[];
  page: number;
  pageSize: number;
  total: number;
}

export interface GuidePage {
  channels: LiveChannel[];
  programs: Record<string, LiveProgram[]>;
  page: number;
  pageSize: number;
  total: number;
}

export interface LiveSearchResult {
  channels: LiveChannel[];
  programs: LiveProgram[];
}

export interface PlayRequestBody {
  directPlay?: boolean;
  maxBitrateBps?: number;
  useTs?: boolean;
}

export interface PlaySession {
  sessionId: string;
  channelId: number;
  channelName: string;
  url: string;
  mode: 'direct' | 'remux' | 'transcode';
  isLive: true;
  dvrWindowSeconds: number;
  segmentSeconds: number;
}

export interface ChannelPrefsBody {
  favorite?: boolean;
  hidden?: boolean;
}

export interface AdminSource {
  id: number;
  name: string;
  kind: 'm3u' | 'xtream';
  url: string;
  username: string | null;
  userAgent: string | null;
  referer: string | null;
  maxStreams: number;
  refreshIntervalHours: number;
  enabled: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  channelCount: number;
  /** Below: reported by the provider panel. Absent until that lands server-side. */
  accountStatus?: string | null;
  expiresAt?: string | null;
  /** False when `maxStreams` came from the panel rather than from an admin,
   *  which is what makes the field read-only until they take it over. */
  maxStreamsIsManual?: boolean;
  includeGroupsPattern?: string | null;
  excludeGroupsPattern?: string | null;
}

export interface CreateAdminSourceBody {
  name: string;
  kind: 'm3u' | 'xtream';
  url: string;
  username?: string;
  password?: string;
  userAgent?: string;
  referer?: string;
  maxStreams?: number;
  refreshIntervalHours?: number;
  enabled?: boolean;
  includeGroupsPattern?: string;
  excludeGroupsPattern?: string;
}

export type UpdateAdminSourceBody = Partial<CreateAdminSourceBody>;

export interface TestSourceBody {
  kind: 'm3u' | 'xtream';
  url: string;
  username?: string;
  password?: string;
  userAgent?: string;
  referer?: string;
}

export interface TestSourceResult {
  ok: boolean;
  kind: 'm3u' | 'xtream';
  /** Entries that would become channels: on demand and filtered-out groups excluded. */
  channelCount: number;
  onDemandCount: number;
  groups: { name: string; count: number }[];
  guideUrl: string | null;
  guideUrls: string[];
  /** A self-refreshing link rebuilt from an uploaded file's own entries. */
  playlistUrlFromFile?: string | null;
  maxConnections: number;
  expiresAt: string | null;
  accountStatus: string | null;
  suggestion?: {
    suggestedKind: 'xtream';
    baseUrl: string;
    username: string;
    password: string;
  };
  error?: string;
}

export interface AdminChannelStream {
  id: number;
  sourceId: number;
  providerName: string;
  qualityLabel: string | null;
  priority: number;
  lastOkAt: string | null;
  lastError: string | null;
}

export interface AdminChannel {
  id: number;
  name: string;
  number: number;
  groupName: string | null;
  enabled: boolean;
  sourceId: number;
  guideChannelId: string | null;
  guideMatchKind: 'id' | 'name' | 'fuzzy' | 'manual' | null;
  guideShiftMinutes: number;
  lastErrorAt: string | null;
  consecutiveFailures: number;
  streams?: AdminChannelStream[];
}

export interface AdminChannelsPage {
  items: AdminChannel[];
  total: number;
  groups: { name: string; count: number }[];
}

export interface BulkChannelSelection {
  channelIds?: number[];
  group?: string;
  sourceId?: number;
  namePattern?: string;
}

export interface BulkChannelUpdateBody {
  selection: BulkChannelSelection;
  enabled?: boolean;
  groupName?: string;
  startNumber?: number;
}

export interface MergeChannelsBody {
  targetChannelId: number;
  sourceChannelIds: number[];
}

export interface UpdateAdminChannelBody {
  name?: string;
  number?: number;
  groupName?: string;
  enabled?: boolean;
  guideChannelId?: string;
  guideShiftMinutes?: number;
}

export interface GuideSource {
  id: number;
  name: string;
  kind: 'xmltv' | 'source';
  url: string | null;
  sourceId: number | null;
  refreshIntervalHours: number;
  timezoneOffsetMinutes: number;
  enabled: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  programCount: number;
}

export type CreateGuideSourceBody = Omit<
  GuideSource,
  'id' | 'lastSyncAt' | 'lastSyncStatus' | 'lastSyncError' | 'programCount'
>;
export type UpdateGuideSourceBody = Partial<CreateGuideSourceBody>;

export interface GuideMatchReport {
  total: number;
  byKind: { id: number; name: number; fuzzy: number; manual: number };
  unmatched: { channelId: number; name: string }[];
  candidates: { id: string; displayName: string; guideSourceId: number }[];
}

/** Drops undefined/empty values. `HttpClient` stringifies every remaining key as a query param. */
function queryParams(obj: Record<string, string | number | boolean | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== '') out[key] = String(value);
  }
  return out;
}

@Injectable({ providedIn: 'root' })
export class LiveTvApiService {
  private readonly http = inject(HttpClient);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly auth = inject(AuthService);

  // ── User routes ──

  getChannels(opts: { group?: string; favoritesOnly?: boolean; query?: string } = {}) {
    return firstValueFrom(
      this.http.get<LiveChannel[]>('/api/livetv/channels', { params: queryParams(opts) }),
    );
  }

  /** Whether the signed-in user has any channel. Silent on failure: it only gates a nav entry. */
  getStatus() {
    return firstValueFrom(
      this.http.get<{ available: boolean }>('/api/livetv/status', {
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      }),
    );
  }

  getOnNow(opts: { page?: number; pageSize?: number; group?: string; query?: string } = {}) {
    return firstValueFrom(
      this.http.get<OnNowPage>('/api/livetv/channels/on-now', {
        params: queryParams(opts),
      }),
    );
  }

  getGuide(opts: {
    from: string;
    to: string;
    group?: string;
    favoritesOnly?: boolean;
    page?: number;
    pageSize?: number;
  }) {
    return firstValueFrom(
      this.http.get<GuidePage>('/api/livetv/guide', { params: queryParams(opts) }),
    );
  }

  getProgram(id: number) {
    return firstValueFrom(this.http.get<LiveProgram>(`/api/livetv/programs/${id}`));
  }

  search(q: string) {
    return firstValueFrom(
      this.http.get<LiveSearchResult>('/api/livetv/search', { params: queryParams({ q }) }),
    );
  }

  /** The 409 capacity case needs the source name/limit for a custom toast, so the
   *  caller reports its own errors instead of the generic interceptor message. */
  play(channelId: number, body: PlayRequestBody = {}) {
    return firstValueFrom(
      this.http.post<PlaySession>(`/api/livetv/channels/${channelId}/play`, body, {
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      }),
    );
  }

  /** Stores a playlist file on the server and answers the location to use as
   *  the source's URL. Avoids the container-path trap of typing a host path. */
  uploadPlaylist(file: File) {
    const body = new FormData();
    body.append('file', file);
    return firstValueFrom(
      this.http.post<{ location: string }>('/api/livetv/admin/sources/playlist', body),
    );
  }

  stopSession(sessionId: string) {
    return firstValueFrom(this.http.delete<void>(`/api/livetv/sessions/${sessionId}`));
  }

  /** Release path for a page that is going away: an Angular request is dropped
   *  mid-flight there, and the provider connection then waits out the idle
   *  timer, which answers 409 to the next tune on a one-connection account.
   *  Bypasses HttpClient (its interceptors don't run on a bare `fetch`), so the
   *  URL and the Bearer header are resolved here the same way they do. */
  stopSessionOnUnload(sessionId: string): void {
    const path = `/api/livetv/sessions/${sessionId}`;
    const url = this.serverConfig.isNative ? this.serverConfig.resolveUrl(path) : path;
    const token = this.serverConfig.isNative ? this.auth.accessToken : null;
    void fetch(url, {
      method: 'DELETE',
      keepalive: true,
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    }).catch(() => {});
  }

  setPrefs(channelId: number, body: ChannelPrefsBody) {
    return firstValueFrom(this.http.put<void>(`/api/livetv/channels/${channelId}/prefs`, body));
  }

  // ── Admin: sources ──

  listSources() {
    return firstValueFrom(this.http.get<AdminSource[]>('/api/livetv/admin/sources'));
  }

  createSource(body: CreateAdminSourceBody) {
    return firstValueFrom(this.http.post<AdminSource>('/api/livetv/admin/sources', body));
  }

  updateSource(id: number, body: UpdateAdminSourceBody) {
    return firstValueFrom(this.http.patch<AdminSource>(`/api/livetv/admin/sources/${id}`, body));
  }

  deleteSource(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/livetv/admin/sources/${id}`));
  }

  /** A failed test renders inline with its own detail, so the generic toast would be noise. */
  testSource(body: TestSourceBody) {
    return firstValueFrom(
      this.http.post<TestSourceResult>('/api/livetv/admin/sources/test', body, {
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      }),
    );
  }

  syncSource(id: number) {
    return firstValueFrom(this.http.post<void>(`/api/livetv/admin/sources/${id}/sync`, {}));
  }

  // ── Admin: channels ──

  listAdminChannels(opts: {
    sourceId?: number;
    group?: string;
    enabled?: boolean;
    query?: string;
    page?: number;
    pageSize?: number;
  }) {
    return firstValueFrom(
      this.http.get<AdminChannelsPage>('/api/livetv/admin/channels', { params: queryParams(opts) }),
    );
  }

  bulkUpdateChannels(body: BulkChannelUpdateBody) {
    return firstValueFrom(this.http.patch<void>('/api/livetv/admin/channels/bulk', body));
  }

  mergeChannels(body: MergeChannelsBody) {
    return firstValueFrom(this.http.post<void>('/api/livetv/admin/channels/merge', body));
  }

  updateChannel(id: number, body: UpdateAdminChannelBody) {
    return firstValueFrom(
      this.http.patch<AdminChannel>(`/api/livetv/admin/channels/${id}`, body),
    );
  }

  // ── Admin: guide ──

  listGuideSources() {
    return firstValueFrom(this.http.get<GuideSource[]>('/api/livetv/admin/guide-sources'));
  }

  createGuideSource(body: CreateGuideSourceBody) {
    return firstValueFrom(this.http.post<GuideSource>('/api/livetv/admin/guide-sources', body));
  }

  updateGuideSource(id: number, body: UpdateGuideSourceBody) {
    return firstValueFrom(
      this.http.patch<GuideSource>(`/api/livetv/admin/guide-sources/${id}`, body),
    );
  }

  deleteGuideSource(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/livetv/admin/guide-sources/${id}`));
  }

  syncGuideSource(id: number) {
    return firstValueFrom(this.http.post<void>(`/api/livetv/admin/guide-sources/${id}/sync`, {}));
  }

  getMatchReport() {
    return firstValueFrom(this.http.get<GuideMatchReport>('/api/livetv/admin/guide/match-report'));
  }

  // ── Admin: access ──

  getRestrictedGroups() {
    return firstValueFrom(this.http.get<string[]>('/api/livetv/admin/access/restricted-groups'));
  }

  setRestrictedGroups(groups: string[]) {
    return firstValueFrom(
      this.http.put<string[]>('/api/livetv/admin/access/restricted-groups', { groups }),
    );
  }

  getUserGroupGrants(userId: number) {
    return firstValueFrom(this.http.get<string[]>(`/api/livetv/admin/access/users/${userId}`));
  }

  setUserGroupGrants(userId: number, groups: string[]) {
    return firstValueFrom(
      this.http.put<string[]>(`/api/livetv/admin/access/users/${userId}`, { groups }),
    );
  }
}
