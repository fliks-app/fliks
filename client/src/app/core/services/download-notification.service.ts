import { Injectable, signal } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';

export interface NativeDownloadEvent {
  type: 'progress' | 'complete' | 'failed' | 'removed';
  id: string;
  progress: number;
  state: string;
  seq: number;
}

interface DownloadNotificationPlugin {
  startDownload(opts: { id: string; hlsUrl: string; token: string }): Promise<void>;
  removeDownload(opts: { id: string }): Promise<void>;
  getDownloads(): Promise<{ downloads: string }>;
  isDownloaded(opts: { id: string }): Promise<{ downloaded: boolean }>;
  pauseDownloads(): Promise<void>;
  resumeDownloads(): Promise<void>;
  addListener(event: string, cb: (data: any) => void): Promise<any>;
}

const DownloadNotification = Capacitor.isNativePlatform()
  ? registerPlugin<DownloadNotificationPlugin>('DownloadNotification')
  : null;

/**
 * Bridge to native ExoPlayer DownloadManager (Android) / AVAssetDownloadTask (iOS).
 * Web: no-op (Shaka offline handles everything in JS).
 */
@Injectable({ providedIn: 'root' })
export class DownloadNotificationService {
  private readonly isNative = Capacitor.isNativePlatform();

  readonly nativeEvent = signal<NativeDownloadEvent | null>(null);
  private eventSeq = 0;

  constructor() {
    if (DownloadNotification) {
      const emit = (type: NativeDownloadEvent['type']) =>
        (data: { id: string; progress: number; state: string }) => {
          this.nativeEvent.set({
            type,
            id: data.id,
            progress: data.progress,
            state: data.state,
            seq: ++this.eventSeq,
          });
        };
      DownloadNotification.addListener('downloadProgress', emit('progress'));
      DownloadNotification.addListener('downloadComplete', emit('complete'));
      DownloadNotification.addListener('downloadFailed', emit('failed'));
      DownloadNotification.addListener('downloadRemoved', emit('removed'));
    }
  }

  /** Start an HLS download via the native platform's download manager. */
  startDownload(id: string, hlsUrl: string, token: string): void {
    if (!this.isNative || !DownloadNotification) return;
    DownloadNotification.startDownload({ id, hlsUrl, token }).catch(() => {});
  }

  /** Remove a download (cancel + delete cached data). */
  async removeDownload(id: string): Promise<void> {
    if (!this.isNative || !DownloadNotification) return;
    await DownloadNotification.removeDownload({ id }).catch(() => {});
  }

  /** Get all downloads with their current state + progress. */
  async getDownloads(): Promise<{ id: string; progress: number; state: string }[]> {
    if (!DownloadNotification) return [];
    try {
      const result = await DownloadNotification.getDownloads();
      return JSON.parse(result.downloads);
    } catch {
      return [];
    }
  }

  /** Check if a specific download is completed. */
  async isDownloaded(id: string): Promise<boolean> {
    if (!DownloadNotification) return false;
    try {
      const result = await DownloadNotification.isDownloaded({ id });
      return result.downloaded;
    } catch {
      return false;
    }
  }
}
