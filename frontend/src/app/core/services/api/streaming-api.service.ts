import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth.service';
import { ServerConfigService } from '../server-config.service';
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
  source: {
    container: string;
    videoCodec: string;
    videoProfile?: string;
    videoLevel?: number;
    videoBitRate?: number;
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
  episodeLabel: string | null;
}

@Injectable({ providedIn: 'root' })
export class StreamingApiService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly serverConfig = inject(ServerConfigService);

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

  getHwAccelInfo() {
    return firstValueFrom(
      this.http.get<{ hwAccel: string }>('/api/stream/info/hw-accel'),
    );
  }

  /**
   * Ask the backend to decide how to play this file based on client capabilities.
   */
  getPlaybackInfo(mediaFileId: number, deviceProfile: DeviceProfile): Promise<PlaybackInfoResponse> {
    const token = this.auth.accessToken;
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
    return firstValueFrom(
      this.http.post<PlaybackInfoResponse>(
        `/api/stream/${mediaFileId}/playback-info${tokenParam}`,
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
      this.http.get<{ data: PlaybackState[]; total: number }>('/api/playback/history', {
        params: { page: String(page), limit: String(limit) },
      }),
    );
  }

  deletePlaybackState(mediaFileId: number) {
    return firstValueFrom(
      this.http.delete<void>(`/api/playback/${mediaFileId}`),
    );
  }
}
