import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth.service';
import { ServerConfigService } from '../server-config.service';
import { CastService } from '../cast.service';
import { DeviceProfile } from '../browser-device-profile.service';

export type PlayMethod = 'DirectPlay' | 'DirectStream' | 'Transcode';

export interface PlaybackInfoResponse {
  mediaFileId: number;
  playMethod: PlayMethod;
  playUrl: string;
  contentType: string;
  transcodeReasons: { flag: string; message: string }[];
  videoCopyStream: boolean;
  audioCopyStream: boolean;
  outputVideoCodec: string;
  outputAudioCodec: string;
  outputContainer: string;
  hwAccel: string;
  tonemapping: boolean;
  /** Cibles par rung (transcodage), comme Jellyfin TranscodingInfo */
  transcodeBitrateByQuality?: Record<
    string,
    {
      videoBitrateBps: number;
      audioBitrateBps: number;
      /** = BANDWIDTH dans master.m3u8 pour cette variante (vidéo + audio) */
      totalBitrateBps: number;
    }
  >;
  /** BANDWIDTH variante remux (DirectStream HLS), aligné serveur / manifeste */
  remuxMasterBandwidthBps?: number;
  source: {
    container: string;
    videoCodec: string;
    videoProfile?: string;
    videoLevel?: number;
    videoBitRate?: number;
    /** ffprobe format.bit_rate (conteneur) quand les flux n’ont pas de bit_rate */
    formatBitRate?: number;
    videoBitDepth?: number;
    width?: number;
    height?: number;
    frameRate?: string;
    audioCodec: string;
    audioChannels?: number;
    audioChannelLayout?: string;
    audioBitRate?: number;
    audioSampleRate?: number;
    audioLanguage?: string;
    durationSeconds?: number;
    hdrFormat?: string;
    colorSpace?: string;
    colorTransfer?: string;
    colorPrimaries?: string;
  };
  /** Episode-level skip markers — only present for series episodes. */
  markers?: {
    intro?: { startSeconds: number; endSeconds: number };
    outro?: { startSeconds: number; endSeconds: number };
  };
  /** Embedded chapters from the container (MKV/MP4). */
  chapters?: { startSeconds: number; endSeconds: number; title?: string }[];
}

export interface MediaResumeInfo {
  mediaFileId: number;
  episodeId: number | null;
  positionSeconds: number;
  durationSeconds: number;
  seasonNumber?: number;
  episodeNumber?: number;
}

export interface PlaybackState {
  id: number;
  mediaId: number;
  mediaFileId: number;
  episodeId: number | null;
  positionSeconds: number;
  durationSeconds: number;
  completed: boolean;
  lastPlayedAt: string;
}

export interface WatchHistoryItem {
  id: number;
  mediaId: number;
  mediaFileId: number;
  episodeId: number | null;
  positionSeconds: number;
  durationSeconds: number;
  progressPercent: number;
  completed: boolean;
  lastPlayedAt: string;
  mediaTitle: string;
  mediaType: string;
  posterUrl: string | null;
  fanartUrl: string | null;
  episodeLabel: string | null;
}

export interface RecommendationItem {
  media: {
    id: number;
    title: string;
    type: string;
    year: number;
    posterUrl: string | null;
    genres: string[];
  };
  becauseTitle: string;
  score: number;
}

export interface ContinueWatchingItem {
  id: number;
  mediaId: number;
  mediaFileId: number;
  episodeId: number | null;
  positionSeconds: number;
  durationSeconds: number;
  progressPercent: number;
  lastPlayedAt: string;
  mediaTitle: string;
  mediaType: string;
  posterUrl: string | null;
  fanartUrl: string | null;
  episodeLabel: string | null;
}

@Injectable({ providedIn: 'root' })
export class StreamingApiService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly castService = inject(CastService);

  /**
   * Build authenticated HLS master playlist URL.
   * `startQuality` tells the backend which quality to pre-start FFmpeg at
   * (e.g. "1080p") — avoids the "first segment fetch spawns FFmpeg at a
   * wrong variant Shaka probed during load" waste.
   */
  getHlsUrl(mediaFileId: number, startQuality?: string, startAt?: number): string {
    const base = this.serverConfig.isNative
      ? this.serverConfig.resolveUrl(`/api/stream/${mediaFileId}/master.m3u8`)
      : `/api/stream/${mediaFileId}/master.m3u8`;
    const params: string[] = [];
    const token = this.auth.accessToken;
    if (token) params.push(`token=${encodeURIComponent(token)}`);
    if (startQuality) params.push(`startQuality=${encodeURIComponent(startQuality)}`);
    if (startAt != null) params.push(`startAt=${startAt}`);
    return params.length ? `${base}?${params.join('&')}` : base;
  }

  /** Build authenticated stream URL for direct play */
  getStreamUrl(mediaFileId: number): string {
    const base = this.serverConfig.isNative
      ? this.serverConfig.resolveUrl(`/api/stream/${mediaFileId}`)
      : `/api/stream/${mediaFileId}`;
    const token = this.auth.accessToken;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }

  /** Build authenticated subtitle URL */
  getSubtitleUrl(mediaFileId: number, subtitleId: number): string {
    const base = this.serverConfig.isNative
      ? this.serverConfig.resolveUrl(`/api/stream/${mediaFileId}/subtitles/${subtitleId}`)
      : `/api/stream/${mediaFileId}/subtitles/${subtitleId}`;
    const token = this.auth.accessToken;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }

  /** Build authenticated thumbnail sprite image URL */
  getThumbnailSpriteUrl(mediaFileId: number): string {
    const base = this.serverConfig.isNative
      ? this.serverConfig.resolveUrl(`/api/stream/${mediaFileId}/thumbnails/sprite.jpg`)
      : `/api/stream/${mediaFileId}/thumbnails/sprite.jpg`;
    const token = this.auth.accessToken;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }

  /** Build authenticated thumbnail sprite metadata URL */
  getThumbnailMetadataUrl(mediaFileId: number): string {
    const base = this.serverConfig.isNative
      ? this.serverConfig.resolveUrl(`/api/stream/${mediaFileId}/thumbnails/sprite.json`)
      : `/api/stream/${mediaFileId}/thumbnails/sprite.json`;
    const token = this.auth.accessToken;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }

  /** Build authenticated embedded subtitle URL */
  getEmbeddedSubtitleUrl(mediaFileId: number, streamIndex: number): string {
    const base = this.serverConfig.isNative
      ? this.serverConfig.resolveUrl(`/api/stream/${mediaFileId}/subtitles/embedded/${streamIndex}`)
      : `/api/stream/${mediaFileId}/subtitles/embedded/${streamIndex}`;
    const token = this.auth.accessToken;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }

  /** URLs absolues pour pistes Cast : base issue de cast-info (reloadCastStream). */
  private absoluteUrl(path: string): string {
    const base = this.castService.castStreamBaseUrl();
    let out: string;
    if (base) out = `${base}${path}`;
    else if (this.serverConfig.isNative) out = this.serverConfig.resolveUrl(path);
    else out = `${window.location.origin}${path}`;
    return out;
  }

  private appendToken(url: string, token: string): string {
    return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  }

  private withToken(url: string): string {
    const token = this.auth.accessToken;
    return token ? this.appendToken(url, token) : url;
  }

  /** Build Cast URLs with a temporary token */
  getAbsoluteHlsUrl(mediaFileId: number, castToken: string): string {
    return this.appendToken(this.absoluteUrl(`/api/stream/${mediaFileId}/master.m3u8`), castToken);
  }

  getAbsoluteStreamUrl(mediaFileId: number, castToken: string): string {
    return this.appendToken(this.absoluteUrl(`/api/stream/${mediaFileId}`), castToken);
  }

  getAbsoluteSubtitleUrl(mediaFileId: number, subtitleId: number, castToken: string): string {
    return this.appendToken(this.absoluteUrl(`/api/stream/${mediaFileId}/subtitles/${subtitleId}`), castToken);
  }

  getAbsoluteEmbeddedSubtitleUrl(mediaFileId: number, streamIndex: number, castToken: string): string {
    return this.appendToken(this.absoluteUrl(`/api/stream/${mediaFileId}/subtitles/embedded/${streamIndex}`), castToken);
  }

  getHwAccelInfo() {
    return firstValueFrom(
      this.http.get<{ hwAccel: string }>('/api/stream/info/hw-accel'),
    );
  }

  /**
   * Ask the backend to decide how to play this file based on client capabilities.
   */
  getPlaybackInfo(mediaFileId: number, deviceProfile: DeviceProfile, burnInSubtitleId?: number, audioStreamIndex?: number): Promise<PlaybackInfoResponse> {
    const token = this.auth.accessToken;
    let params = token ? `?token=${encodeURIComponent(token)}` : '';
    if (burnInSubtitleId) {
      params += (params ? '&' : '?') + `burnInSubtitleId=${burnInSubtitleId}`;
    }
    if (audioStreamIndex != null) {
      params += (params ? '&' : '?') + `audioStreamIndex=${audioStreamIndex}`;
    }
    return firstValueFrom(
      this.http.post<PlaybackInfoResponse>(
        `/api/stream/${mediaFileId}/playback-info${params}`,
        deviceProfile,
      ),
    );
  }

  /** Build the URL for stopping sessions (used with sendBeacon on unload). */
  getStopSessionsUrl(mediaFileId: number): string {
    const base = this.serverConfig.isNative
      ? this.serverConfig.resolveUrl(`/api/stream/${mediaFileId}/sessions`)
      : `/api/stream/${mediaFileId}/sessions`;
    const token = this.auth.accessToken;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }

  stopSessions(mediaFileId: number) {
    return firstValueFrom(
      this.http.delete(`/api/stream/${mediaFileId}/sessions`),
    );
  }

  getWatchedEpisodeIds(mediaId: number) {
    return firstValueFrom(
      this.http.get<number[]>(`/api/playback/media/${mediaId}/watched-episodes`),
    );
  }

  getEpisodeProgress(mediaId: number) {
    return firstValueFrom(
      this.http.get<Record<number, number>>(
        `/api/playback/media/${mediaId}/episode-progress`,
      ),
    );
  }

  getMediaResumeInfo(mediaId: number) {
    return firstValueFrom(
      this.http.get<MediaResumeInfo | null>(`/api/playback/media/${mediaId}`),
    );
  }

  getPlaybackState(mediaId: number, episodeId?: number) {
    const params = episodeId ? `?episodeId=${episodeId}` : '';
    return firstValueFrom(
      this.http.get<PlaybackState | null>(`/api/playback/media/${mediaId}/state${params}`),
    );
  }

  updatePlaybackState(
    mediaId: number,
    body: {
      positionSeconds: number;
      durationSeconds: number;
      mediaFileId: number;
      episodeId?: number;
    },
  ) {
    return firstValueFrom(
      this.http.put<PlaybackState>(`/api/playback/media/${mediaId}/state`, body),
    );
  }

  getContinueWatching() {
    return firstValueFrom(
      this.http.get<ContinueWatchingItem[]>('/api/playback/continue-watching'),
    );
  }

  getRecommendations() {
    return firstValueFrom(
      this.http.get<RecommendationItem[]>('/api/playback/recommendations'),
    );
  }

  getHistory(page = 1, limit = 25) {
    return firstValueFrom(
      this.http.get<{ data: WatchHistoryItem[]; total: number }>('/api/playback/history', {
        params: { page: String(page), limit: String(limit) },
      }),
    );
  }

  deletePlaybackState(mediaId: number, episodeId?: number) {
    const params = episodeId ? `?episodeId=${episodeId}` : '';
    return firstValueFrom(
      this.http.delete<void>(`/api/playback/media/${mediaId}/state${params}`),
    );
  }

  getWatchedMediaIds(): Promise<number[]> {
    return firstValueFrom(this.http.get<number[]>('/api/playback/watched-ids'));
  }

  toggleWatched(mediaId: number, mediaFileId: number, episodeId?: number) {
    return firstValueFrom(
      this.http.post<PlaybackState>(`/api/playback/media/${mediaId}/toggle-watched`, { mediaFileId, episodeId }),
    );
  }

  /**
   * Mark every episode of a series as watched/unwatched in a single request.
   * The caller should refresh the episode watched list after this.
   */
  toggleSeriesWatched(mediaId: number, watched: boolean) {
    return firstValueFrom(
      this.http.post<{ watched: boolean }>(
        `/api/playback/media/${mediaId}/toggle-series-watched`,
        { watched },
      ),
    );
  }

  toggleSeasonWatched(mediaId: number, seasonId: number, watched: boolean) {
    return firstValueFrom(
      this.http.post<{ watched: boolean }>(
        `/api/playback/media/${mediaId}/seasons/${seasonId}/toggle-watched`,
        { watched },
      ),
    );
  }

  hideFromContinueWatching(mediaId: number) {
    return firstValueFrom(
      this.http.delete<void>(`/api/playback/hide/${mediaId}`),
    );
  }

  getDownloadQualities(mediaFileId: number) {
    return firstValueFrom(
      this.http.get<DownloadQuality[]>(`/api/stream/info/qualities/${mediaFileId}`),
    );
  }
}

export interface DownloadQuality {
  key: string;
  label: string;
  estimatedSize: number;
}
