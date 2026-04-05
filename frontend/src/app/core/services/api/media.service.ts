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

export interface SuitarrQualityDef {
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
  episodes: Episode[];
}

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
  rootFolderId?: number | null;
  posterUrl: string | null;
  fanartUrl: string | null;
  rating: number;
  genres?: string[];
  runtime: number;
  releaseDate?: string | null;
  inCinemas?: string | null;
  digitalRelease?: string | null;
  physicalRelease?: string | null;
  tags: { id: number; label: string }[];
  seasons?: Season[];
  files?: { id: number; quality: string; relativePath: string; size: number; episodeId?: number | null; streamInfo?: MediaFileInfo | null }[];
  qualityProfile?: QualityProfileBrief | null;
  languageProfile?: { id: number; name: string } | null;
  minimumAvailability?: 'announced' | 'inCinemas' | 'released';
  sizeOnDisk?: number;
  episodeStats?: { totalEpisodes: number; downloadedEpisodes: number };
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
  tagId?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
  page?: number;
  limit?: number;
  missing?: boolean;
  cutoffUnmet?: boolean;
  letter?: string;
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

export interface MediaFileInfo {
  video: VideoStreamInfo[];
  audio: AudioStreamInfo[];
  subtitles: SubtitleStreamInfo[];
  durationSeconds?: number;
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class MediaService {
  private readonly http = inject(HttpClient);

  getCounts() {
    return firstValueFrom(this.http.get<{ movies: number; series: number }>('/api/media/counts'));
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

  getSuitarrQualities() {
    return firstValueFrom(this.http.get<SuitarrQualityDef[]>('/api/media/qualities'));
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

  renameFiles(id: number) {
    return firstValueFrom(this.http.post<{ renamed: number }>(`/api/media/${id}/rename`, {}));
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

  patchRootFolder(id: number, rootFolderId: number) {
    return firstValueFrom(this.http.patch<Media>(`/api/media/${id}/root-folder`, { rootFolderId }));
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

  getCalendar(start: string, end: string) {
    return firstValueFrom(
      this.http.get<CalendarEntry[]>('/api/media/calendar', {
        params: { start, end },
      }),
    );
  }

  linkTorrent(mediaId: number, sourceTitle: string, clientId?: number) {
    return firstValueFrom(
      this.http.post('/api/media/history/link', { mediaId, sourceTitle, clientId }),
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
    return firstValueFrom(
      this.http.patch<Season>(`/api/media/seasons/${seasonId}`, { monitored }),
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

  rescanFiles(id: number) {
    return firstValueFrom(this.http.post<{ added: number; removed: number; updated: number }>(`/api/media/${id}/rescan`, {}));
  }

}
