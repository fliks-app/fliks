import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { MediaType } from '../../enums/media-type.enum';

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

export interface MovieRelease {
  title: string;
  downloadUrl: string;
  qualityId: number;
  qualityName: string;
  rank: number;
  allowed: boolean;
  customFormatScore: number;
  blocklisted: boolean;
  indexerId: number;
  indexerName: string;
  languageId: number;
  languageName: string;
  languageAllowed: boolean;
  size: number;
  seeders: number;
  leechers: number;
  rejections: { code: string; params?: Record<string, number | string> }[];
  freeleech: boolean;
  downloadVolumeFactor: number;
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
  hasFile: boolean;
  runtime?: number | null;
  stillUrl?: string | null;
}

export interface Season {
  id: number;
  seasonNumber: number;
  monitored: boolean;
  preferredProvider?: 'tmdb' | 'tvdb' | null;
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
  rating: number;
  genres?: string[];
  runtime: number;
  releaseDate?: string | null;
  inCinemas?: string | null;
  digitalRelease?: string | null;
  physicalRelease?: string | null;
  seasons?: Season[];
  files?: { id: number; quality: string; relativePath: string; size: number; episodeId?: number | null; streamInfo?: MediaFileInfo | null }[];
  qualityProfile?: QualityProfileBrief | null;
  languageProfile?: { id: number; name: string } | null;
  minimumAvailability?: 'announced' | 'inCinemas' | 'released';
  sizeOnDisk?: number;
  episodeStats?: { totalEpisodes: number; downloadedEpisodes: number };
  preferredProvider?: 'tmdb' | 'tvdb' | null;
  imdbId?: string | null;
  metadata?: MediaMetadataBrief | null;
}

/** Extended TMDB fields rendered in the media-detail info panel. */
export interface MediaMetadataBrief {
  budget: number | null;
  revenue: number | null;
  tagline: string | null;
  originalLanguage: string | null;
  productionCountries: string[] | null;
  productionCompanies: string[] | null;
}

export interface MediaCastEntry {
  id: number;
  character: string;
  order: number;
  person: { id: number; name: string; avatarUrl: string | null };
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

export interface SearchParams {
  q?: string;
  type?: MediaType;
  status?: string;
  monitored?: boolean;
  year?: number;
  genre?: string;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
  page?: number;
  limit?: number;
  missing?: boolean;
  cutoffUnmet?: boolean;
  letter?: string;
  excludeWatched?: boolean;
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

  getAll(params: SearchParams = {}) {
    let httpParams = new HttpParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        httpParams = httpParams.set(key, String(value));
      }
    }
    return firstValueFrom(this.http.get<MediaPage>('/api/media', { params: httpParams }));
  }

  getOne(id: number) {
    return firstValueFrom(this.http.get<Media>(`/api/media/${id}`));
  }

  getCast(id: number) {
    return firstValueFrom(this.http.get<MediaCastEntry[]>(`/api/media/${id}/cast`));
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

  getMovieReleases(id: number, q?: string) {
    const params: Record<string, string> = {};
    if (q?.trim()) params['q'] = q.trim();
    return firstValueFrom(this.http.get<MovieRelease[]>(`/api/media/${id}/releases`, { params }));
  }

  grabMovie(id: number, body?: { downloadUrl?: string; sourceTitle?: string }) {
    return firstValueFrom(
      this.http.post<{ id: number; status: string }>(
        `/api/media/${id}/grab`,
        body ?? {},
      ),
    );
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

  getCalendar(start: string, end: string, monitoredOnly = false, requestedByMe = false) {
    const params: Record<string, string> = { start, end };
    if (monitoredOnly) params['monitoredOnly'] = 'true';
    if (requestedByMe) params['requestedByMe'] = 'true';
    return firstValueFrom(
      this.http.get<CalendarEntry[]>('/api/media/calendar', { params }),
    );
  }

  linkTorrent(mediaId: number, torrentHash: string) {
    return firstValueFrom(
      this.http.post('/api/download-clients/queue/link', { mediaId, torrentHash }),
    );
  }

  getSeasonReleases(mediaId: number, seasonId: number, q?: string) {
    const params: Record<string, string> = {};
    if (q?.trim()) params['q'] = q.trim();
    return firstValueFrom(
      this.http.get<MovieRelease[]>(`/api/media/${mediaId}/seasons/${seasonId}/releases`, { params }),
    );
  }

  grabSeason(mediaId: number, seasonId: number, body?: { downloadUrl?: string; sourceTitle?: string }) {
    return firstValueFrom(
      this.http.post<{ grabbed: number; errors: string[] }>(
        `/api/media/${mediaId}/seasons/${seasonId}/grab`,
        body ?? {},
      ),
    );
  }

  getEpisodeReleases(mediaId: number, episodeId: number, q?: string) {
    const params: Record<string, string> = {};
    if (q?.trim()) params['q'] = q.trim();
    return firstValueFrom(
      this.http.get<MovieRelease[]>(`/api/media/${mediaId}/episodes/${episodeId}/releases`, { params }),
    );
  }

  grabEpisode(mediaId: number, episodeId: number, body?: { downloadUrl?: string; sourceTitle?: string }) {
    return firstValueFrom(
      this.http.post<{ id: number; status: string }>(
        `/api/media/${mediaId}/episodes/${episodeId}/grab`,
        body ?? {},
      ),
    );
  }

  getUpgradeReleases(mediaId: number, q?: string) {
    const params: Record<string, string> = {};
    if (q?.trim()) params['q'] = q.trim();
    return firstValueFrom(
      this.http.get<MovieRelease[]>(`/api/media/${mediaId}/upgrade-releases`, { params }),
    );
  }

  grabUpgrade(mediaId: number, body?: { downloadUrl?: string; sourceTitle?: string }) {
    return firstValueFrom(
      this.http.post<{ id: number; status: string }>(
        `/api/media/${mediaId}/upgrade`,
        body ?? {},
      ),
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

  bulkUpdate(body: { ids: number[]; qualityProfileId?: number; languageProfileId?: number; monitored?: boolean; rootFolder?: string }) {
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

}
