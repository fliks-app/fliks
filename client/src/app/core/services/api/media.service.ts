import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { MediaType } from '../../enums/media-type.enum';
import { CACHE_BYPASS_HEADER } from '../../interceptors/cache.interceptor';

export interface QualityProfileBrief {
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

export interface AppQualityDef {
  id: number;
  name: string;
  resolution: number;
  source: string;
  rank: number;
}

export interface Episode {
  id: number;
  episodeNumber: number;
  /** Last episode number for multi-episode files (S07E25-E26 → 26). null/absent = single. */
  endEpisodeNumber?: number | null;
  title: string | null;
  overview: string | null;
  airDate: string | null;
  monitored: boolean;
  /** Has its own file (playback / watched). "On disk" coverage incl. multi-
   *  episode files is derived client-side via media-detail.utils. */
  hasFile: boolean;
  runtime?: number | null;
  stillUrl?: string | null;
}

export interface Season {
  id: number;
  seasonNumber: number;
  monitored: boolean;
  preferredProvider?: 'tmdb' | 'tvdb' | null;
  /** Season-specific poster (TMDB/TVDB); null → fall back to series poster. */
  posterUrl: string | null;
  /** Season synopsis; null on providers that don't carry one (TVDB). */
  overview?: string | null;
  /** First air date. May be a bare year: that's what TVDB reports. */
  airDate?: string | null;
  episodes: Episode[];
}

export type MetadataProvider = 'tmdb' | 'tvdb';

export interface Media {
  id: number;
  title: string;
  originalTitle: string;
  year: number;
  type: MediaType;
  tmdbId: number;
  overview: string;
  status: string;
  monitored: boolean;
  path?: string | null;
  libraryId?: number | null;
  library?: { id: number; name: string } | null;
  posterUrl: string | null;
  fanartUrl: string | null;
  /** Transparent PNG clearlogo (title treatment), or null. */
  logoUrl: string | null;
  /** Extra fanarts kept locally (variants `fanart-1`..`fanart-N`).
   *  Mixed with {@link fanartUrl} for the randomised page background. */
  additionalFanartUrls: string[];
  rating: number;
  genres?: string[];
  runtime: number;
  releaseDate?: string | null;
  inCinemas?: string | null;
  digitalRelease?: string | null;
  physicalRelease?: string | null;
  seasons?: Season[];
  files?: { id: number; quality: string; relativePath: string; size: number; createdAt?: string; episodeId?: number | null; streamInfo?: MediaFileInfo | null }[];
  qualityProfile?: QualityProfileBrief | null;
  languageProfile?: { id: number; name: string } | null;
  minimumAvailability?: 'announced' | 'inCinemas' | 'released';
  sizeOnDisk?: number;
  episodeStats?: { totalEpisodes: number; downloadedEpisodes: number };
  /** Fully watched (movie completed / series all episodes watched), per user. */
  watched?: boolean;
  /** Resume progress 0-100 (movies only; 0 for series). */
  progressPercent?: number;
  preferredProvider?: 'tmdb' | 'tvdb' | null;
  imdbId?: string | null;
  metadata?: MediaMetadataBrief | null;
}

export type CutoffState =
  | 'unmonitored'
  | 'no-profile'
  | 'missing'
  | 'below'
  | 'met';

export interface TrackingItemState {
  monitored: boolean;
  state: CutoffState;
  currentQuality?: string;
  targetQuality?: string;
}

export interface TrackingEpisode extends TrackingItemState {
  episodeId: number;
  seasonNumber: number;
  episodeNumber: number;
  endEpisodeNumber: number | null;
  title: string | null;
}

export interface TrackingStatus {
  type: 'movie' | 'series';
  hasProfile: boolean;
  movie?: TrackingItemState;
  seasons?: { seasonNumber: number; episodes: TrackingEpisode[] }[];
}

/** Extended TMDB fields rendered in the media-detail info panel. */
export interface MediaMetadataBrief {
  budget: number | null;
  revenue: number | null;
  tagline: string | null;
  originalLanguage: string | null;
  productionCountries: string[] | null;
  productionCompanies: string[] | null;
  videos?: { key: string; site: string; type: string; name: string }[] | null;
}

export interface MediaCastEntry {
  id: number;
  character: string;
  order: number;
  person: { id: number; name: string; avatarUrl: string | null };
}

/** Movie from the same library, related to the one being viewed. */
export interface RelatedMedia {
  id: number;
  title: string;
  year: number;
  posterUrl: string | null;
  rating: number | null;
  genres: string[];
  hasFile: boolean;
}

/** TMDB collection the viewed movie belongs to, minus the movie itself. */
export interface MediaCollection {
  id: number;
  name: string;
  items: RelatedMedia[];
}

export interface MediaCrewEntry {
  id: number;
  job: string;
  department: string;
  person: { id: number; name: string; avatarUrl: string | null };
}

export interface CalendarEntry {
  id: number;
  mediaId: number;
  title: string;
  type: MediaType;
  event: string;
  date: string;
  posterUrl: string | null;
  status: string;
  year: number;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string;
  hasFile?: boolean;
}

export interface MediaPage {
  data: Media[];
  total: number;
}

/** One row of the library Genres tab: a genre, how many media carry it,
 *  and the URLs of the first up-to-4 posters (rendered as a mosaic
 *  when populated, fallback folder icon when empty). */
export interface GenreSummary {
  genre: string;
  count: number;
  posters: string[];
}

export interface CollectionSummary {
  id: number;
  name: string;
  count: number;
  posters: string[];
}

export interface SearchParams {
  q?: string;
  type?: MediaType;
  status?: string;
  monitored?: boolean;
  year?: number;
  genre?: string;
  /** Multi-genre filter matched by name; all must be present (AND). */
  genres?: string[];
  yearMin?: number;
  yearMax?: number;
  /** Minimum rating (compared against media.rating). */
  voteMin?: number;
  collectionId?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
  page?: number;
  limit?: number;
  missing?: boolean;
  cutoffUnmet?: boolean;
  letter?: string;
  excludeWatched?: boolean;
  onlyWatched?: boolean;
  libraryId?: number;
  requestedByMe?: boolean;
}

export interface VideoStreamInfo {
  streamIndex: number;
  codec: string;
  profile?: string;
  level?: number;
  width?: number;
  height?: number;
  displayAspectRatio?: string;
  pixelFormat?: string;
  frameRate?: string;
  bitRate?: number;
  bitDepth?: number;
  colorSpace?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  hdrFormat?: string;
  dvProfile?: number;
  dvBlSignalCompatId?: number;
}

export interface AudioStreamInfo {
  streamIndex: number;
  codec: string;
  language: string;
  title?: string;
  channels?: number;
  channelLayout?: string;
  sampleRate?: number;
  bitRate?: number;
  isDefault?: boolean;
}

export interface SubtitleStreamInfo {
  streamIndex: number;
  codec: string;
  language: string;
  title?: string;
  forced: boolean;
  hearingImpaired: boolean;
}

export interface Chapter {
  startSeconds: number;
  endSeconds: number;
  title?: string;
}

export interface MediaFileInfo {
  video: VideoStreamInfo[];
  audio: AudioStreamInfo[];
  subtitles: SubtitleStreamInfo[];
  /** Overall container bitrate from ffprobe (bits/s). */
  formatBitRate?: number;
  durationSeconds?: number;
  chapters?: Chapter[];
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class MediaService {
  private readonly http = inject(HttpClient);

  getCounts() {
    return firstValueFrom(this.http.get<{ movies: number; series: number }>('/api/media/counts'));
  }

  getCountsByLibrary() {
    return firstValueFrom(
      this.http.get<Record<number, number>>('/api/media/counts-by-library'),
    );
  }

  getGenres(libraryId?: number, opts: { force?: boolean } = {}) {
    const reqOpts: { params?: { libraryId: string }; headers?: { [k: string]: string } } = {};
    if (libraryId) reqOpts.params = { libraryId: String(libraryId) };
    if (opts.force) reqOpts.headers = { [CACHE_BYPASS_HEADER]: '1' };
    return firstValueFrom(
      this.http.get<GenreSummary[]>('/api/media/genres', reqOpts),
    );
  }

  getCollections(libraryId?: number, opts: { force?: boolean } = {}) {
    const reqOpts: { params?: { libraryId: string }; headers?: { [k: string]: string } } = {};
    if (libraryId) reqOpts.params = { libraryId: String(libraryId) };
    if (opts.force) reqOpts.headers = { [CACHE_BYPASS_HEADER]: '1' };
    return firstValueFrom(
      this.http.get<CollectionSummary[]>('/api/media/collections', reqOpts),
    );
  }

  getAll(params: SearchParams = {}, opts: { force?: boolean } = {}) {
    let httpParams = new HttpParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        if (value.length) httpParams = httpParams.set(key, value.join(','));
        continue;
      }
      httpParams = httpParams.set(key, String(value));
    }
    const headers = opts.force ? { [CACHE_BYPASS_HEADER]: '1' } : undefined;
    return firstValueFrom(
      this.http.get<MediaPage>('/api/media', headers ? { params: httpParams, headers } : { params: httpParams }),
    );
  }

  getOne(id: number, opts: { force?: boolean } = {}) {
    const headers = opts.force ? { [CACHE_BYPASS_HEADER]: '1' } : undefined;
    return firstValueFrom(
      this.http.get<Media>(`/api/media/${id}`, headers ? { headers } : {}),
    );
  }

  /** Home "Recently added" feed. `mode` picks the ranking basis (media
   *  add time / newest file / both); `libraryId` scopes to one library. */
  getRecentlyAdded(
    params: {
      libraryId?: number;
      limit?: number;
      mode?: 'media' | 'file' | 'both';
      excludeWatched?: boolean;
      requestedByMe?: boolean;
    } = {},
    opts: { force?: boolean } = {},
  ) {
    let httpParams = new HttpParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        httpParams = httpParams.set(key, String(value));
      }
    }
    const headers = opts.force ? { [CACHE_BYPASS_HEADER]: '1' } : undefined;
    return firstValueFrom(
      this.http.get<Media[]>(
        '/api/media/recently-added',
        headers ? { params: httpParams, headers } : { params: httpParams },
      ),
    );
  }

  getTracking(id: number) {
    return firstValueFrom(
      this.http.get<TrackingStatus>(`/api/media/${id}/tracking`),
    );
  }

  getCast(id: number) {
    return firstValueFrom(this.http.get<MediaCastEntry[]>(`/api/media/${id}/cast`));
  }

  getSimilar(id: number) {
    return firstValueFrom(
      this.http.get<RelatedMedia[]>(`/api/media/${id}/similar`),
    );
  }

  getCollection(id: number) {
    return firstValueFrom(
      this.http.get<MediaCollection | null>(`/api/media/${id}/collection`),
    );
  }

  getCrew(id: number) {
    return firstValueFrom(this.http.get<MediaCrewEntry[]>(`/api/media/${id}/crew`));
  }

  getAppQualities() {
    return firstValueFrom(this.http.get<AppQualityDef[]>('/api/media/qualities'));
  }

  create(data: Partial<Media>) {
    return firstValueFrom(this.http.post<Media>('/api/media', data));
  }

  update(id: number, data: Partial<Media>) {
    return firstValueFrom(this.http.put<Media>(`/api/media/${id}`, data));
  }

  delete(id: number) {
    return firstValueFrom(this.http.delete(`/api/media/${id}`));
  }

  deleteFile(mediaId: number, fileId: number, deleteOnDisk: boolean) {
    return firstValueFrom(
      this.http.delete<void>(`/api/media/${mediaId}/files/${fileId}`, {
        params: { deleteOnDisk: String(deleteOnDisk) },
      }),
    );
  }

  /** Move media to a different library (backend resolves an appropriate path inside it). */
  patchLibrary(id: number, libraryId: number) {
    return firstValueFrom(this.http.patch<Media>(`/api/media/${id}/library`, { libraryId }));
  }

  patchProfiles(
    id: number,
    body: { qualityProfileId: number | null; languageProfileId: number | null },
  ) {
    return firstValueFrom(this.http.patch<Media>(`/api/media/${id}/profiles`, body));
  }

  toggleMonitored(id: number, monitored: boolean) {
    return firstValueFrom(this.http.put<Media>(`/api/media/${id}`, { monitored }));
  }

  getCalendar(start: string, end: string, monitoredOnly = false, requestedByMe = false, opts: { force?: boolean } = {}) {
    const params: Record<string, string> = { start, end };
    if (monitoredOnly) params['monitoredOnly'] = 'true';
    if (requestedByMe) params['requestedByMe'] = 'true';
    const headers = opts.force ? { [CACHE_BYPASS_HEADER]: '1' } : undefined;
    return firstValueFrom(
      this.http.get<CalendarEntry[]>('/api/media/calendar', headers ? { params, headers } : { params }),
    );
  }

  updateSeasonMonitored(seasonId: number, monitored: boolean) {
    return this.updateSeason(seasonId, { monitored });
  }

  updateSeason(
    seasonId: number,
    patch: { monitored?: boolean; preferredProvider?: 'tmdb' | 'tvdb' | null },
  ) {
    return firstValueFrom(
      this.http.patch<Season>(`/api/media/seasons/${seasonId}`, patch),
    );
  }

  updateEpisodeMonitored(episodeId: number, monitored: boolean) {
    return firstValueFrom(
      this.http.patch<Episode>(`/api/media/episodes/${episodeId}`, { monitored }),
    );
  }

  bulkUpdate(body: { ids: number[]; qualityProfileId?: number; languageProfileId?: number; monitored?: boolean; libraryId?: number }) {
    return firstValueFrom(this.http.patch<{ updated: number }>('/api/media/bulk', body));
  }

  refreshMetadata(id: number) {
    return firstValueFrom(this.http.post<Media>(`/api/media/${id}/refresh`, {}));
  }

  refreshEpisodeMetadata(mediaId: number, episodeId: number) {
    return firstValueFrom(this.http.post<Media>(`/api/media/${mediaId}/episodes/${episodeId}/refresh`, {}));
  }

  rescanFiles(id: number) {
    return firstValueFrom(this.http.post<{ ok: boolean }>(`/api/media/${id}/rescan`, {}));
  }

  analyzeMedia(
    id: number,
    opts: { sprites?: boolean; crop?: boolean; subtitleCache?: boolean },
  ) {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>(`/api/media/${id}/analyze`, opts),
    );
  }

}
