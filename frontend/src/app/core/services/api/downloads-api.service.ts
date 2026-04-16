import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ServerConfigService } from '../server-config.service';
import { AuthService } from '../auth.service';
import { DeviceIdService } from '../device-id.service';

export interface DownloadTask {
  id: number;
  mediaId: number;
  episodeId?: number;
  mediaFileId: number;
  quality: string;
  status: string;
  progress: number;
  fileSize?: number;
  episodeLabel?: string;
  subtitles?: { language: string; forced: boolean; filename: string }[];
  error?: string;
  createdAt: string;
  segmentCount?: number;
  totalSegments?: number;
  segmentDuration?: number;
  media?: {
    id: number;
    title: string;
    posterUrl: string | null;
    type: string;
  };
}

export interface ProgressiveStatus {
  segmentCount: number;
  totalSegments: number | null;
  segmentDuration: number;
  done: boolean;
}

export interface DownloadQuality {
  key: string;
  label: string;
  estimatedSize: number;
}

@Injectable({ providedIn: 'root' })
export class DownloadsApiService {
  private readonly http = inject(HttpClient);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly auth = inject(AuthService);
  private readonly device = inject(DeviceIdService);

  getQualities(mediaFileId: number) {
    return firstValueFrom(
      this.http.get<DownloadQuality[]>(`/api/downloads/qualities/${mediaFileId}`),
    );
  }

  create(mediaFileId: number, quality: string, deviceProfile?: {
    supportsHdr?: boolean;
    audioCodecs?: string[];
    videoCodecs?: string[];
    maxAudioChannels?: number;
  }) {
    return firstValueFrom(
      this.http.post<DownloadTask>('/api/downloads', {
        mediaFileId, quality, deviceProfile, deviceId: this.device.deviceId,
      }),
    );
  }

  list() {
    return firstValueFrom(
      this.http.get<DownloadTask[]>('/api/downloads', {
        params: { deviceId: this.device.deviceId },
      }),
    );
  }

  getOne(id: number) {
    return firstValueFrom(this.http.get<DownloadTask>(`/api/downloads/${id}`));
  }

  delete(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/downloads/${id}`));
  }

  retry(id: number, deviceProfile?: {
    supportsHdr?: boolean;
    audioCodecs?: string[];
    maxAudioChannels?: number;
  }) {
    return firstValueFrom(
      this.http.post<DownloadTask>(`/api/downloads/${id}/retry`, { deviceProfile }),
    );
  }

  /** Notify server that client has downloaded the file */
  ackDownloaded(id: number) {
    return firstValueFrom(
      this.http.post<void>(`/api/downloads/${id}/ack`, {}),
    );
  }

  getSubtitleUrl(id: number, filename: string): string {
    const base = this.serverConfig.isNative
      ? this.serverConfig.resolveUrl(`/api/downloads/${id}/subtitle/${filename}`)
      : `/api/downloads/${id}/subtitle/${filename}`;
    const token = this.auth.accessToken;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }

  getProgressiveStatus(id: number) {
    return firstValueFrom(
      this.http.get<ProgressiveStatus>(`/api/downloads/${id}/status`),
    );
  }

  getSegmentUrl(id: number, filename: string): string {
    const base = this.serverConfig.isNative
      ? this.serverConfig.resolveUrl(`/api/downloads/${id}/segment/${filename}`)
      : `/api/downloads/${id}/segment/${filename}`;
    const token = this.auth.accessToken;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }

}
