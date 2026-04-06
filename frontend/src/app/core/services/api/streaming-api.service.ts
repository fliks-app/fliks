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

  /** Build authenticated HLS master playlist URL */
  getHlsUrl(mediaFileId: number): string {
    const base = this.serverConfig.isNative
      ? this.serverConfig.resolveUrl(`/api/stream/${mediaFileId}/master.m3u8`)
      : `/api/stream/${mediaFileId}/master.m3u8`;
    const token = this.auth.accessToken;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
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

  /** Build authenticated embedded subtitle URL */
  getEmbeddedSubtitleUrl(mediaFileId: number, streamIndex: number): string {
    const base = this.serverConfig.isNative
      ? this.serverConfig.resolveUrl(`/api/stream/${mediaFileId}/subtitles/embedded/${streamIndex}`)
      : `/api/stream/${mediaFileId}/subtitles/embedded/${streamIndex}`;
    const token = this.auth.accessToken;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }

  /**
   * Always-absolute URL for Cast (Chromecast needs full LAN hostname).
   * Uses castServerUrl if configured, otherwise derives from current origin.
   */
  private absoluteUrl(path: string): string {
    if (this.serverConfig.isNative) return this.serverConfig.resolveUrl(path);
    const lanUrl = this.castService.serverLanUrl();
    if (lanUrl) return `${lanUrl}${path}`;
    return `${window.location.origin}${path}`;
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

  getPlaybackState(mediaFileId: number) {
    return firstValueFrom(
      this.http.get<PlaybackState | null>(`/api/playback/${mediaFileId}`),
    );
  }

  updatePlaybackState(
    mediaFileId: number,
    body: {
      positionSeconds: number;
      durationSeconds: number;
      mediaId: number;
      episodeId?: number;
    },
  ) {
    return firstValueFrom(
      this.http.put<PlaybackState>(`/api/playback/${mediaFileId}`, body),
    );
  }

  getContinueWatching() {
    return firstValueFrom(
      this.http.get<ContinueWatchingItem[]>('/api/playback/continue-watching'),
    );
  }

  getHistory(page = 1, limit = 25) {
    return firstValueFrom(
      this.http.get<{ data: WatchHistoryItem[]; total: number }>('/api/playback/history', {
        params: { page: String(page), limit: String(limit) },
      }),
    );
  }

  deletePlaybackState(mediaFileId: number) {
    return firstValueFrom(
      this.http.delete<void>(`/api/playback/${mediaFileId}`),
    );
  }

  getWatchedMediaIds(): Promise<number[]> {
    return firstValueFrom(this.http.get<number[]>('/api/playback/watched-ids'));
  }

  toggleWatched(mediaFileId: number, mediaId: number, episodeId?: number) {
    return firstValueFrom(
      this.http.post<PlaybackState>(`/api/playback/${mediaFileId}/toggle-watched`, { mediaId, episodeId }),
    );
  }

  hideFromContinueWatching(mediaId: number) {
    return firstValueFrom(
      this.http.delete<void>(`/api/playback/hide/${mediaId}`),
    );
  }
}
