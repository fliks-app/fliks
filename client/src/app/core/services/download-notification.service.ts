import { Injectable, signal } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';

export interface NativeDownloadEvent {
  type: 'progress' | 'complete' | 'failed' | 'removed';
  id: string;
  progress: number;
  state: string;
  seq: number;
}

/** Pre-translated notification copy shown by the native download daemon (iOS),
 *  on the completion banner and on the download's Live Activity. */
export interface DownloadNotifStrings {
  notifTitle: string;
  notifProgress: string;
  notifComplete: string;
  notifFailed: string;
}

/** Pre-translated copy for the iOS Live Activity covering the download queue.
 *  The native side owns the numbers; only the wording comes from here. */
export interface DownloadActivityCopy {
  /** Media title for a lone download, a count for a batch. */
  headline: string;
  detail: string;
  complete: string;
  failed: string;
}

interface DownloadNotificationPlugin {
  startDownload(
    opts: { id: string; hlsUrl: string; token: string } & Partial<DownloadNotifStrings>,
  ): Promise<void>;
  removeDownload(opts: { id: string }): Promise<void>;
  getDownloads(): Promise<{ downloads: string }>;
  isDownloaded(opts: { id: string }): Promise<{ downloaded: boolean }>;
  /** iOS: local `file://` URL of the downloaded .movpkg, or null. Unused on Android. */
  getOfflineUrl(opts: { id: string }): Promise<{ url: string | null }>;
  pauseDownloads(): Promise<void>;
  resumeDownloads(): Promise<void>;
  setActivityCopy(opts: DownloadActivityCopy): Promise<void>;
  setMaxConcurrentDownloads(opts: { max: number }): Promise<void>;
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

  /**
   * Start an HLS download via the native platform's download manager.
   * `notif` carries pre-translated banner copy for iOS completion/failure
   * notifications (ignored on Android, which builds its own foreground-service
   * notification).
   */
  startDownload(id: string, hlsUrl: string, token: string, notif?: DownloadNotifStrings): void {
    if (!this.isNative || !DownloadNotification) return;
    DownloadNotification.startDownload({ id, hlsUrl, token, ...(notif ?? {}) }).catch(() => {});
  }

  /**
   * iOS: resolve the local `file://` URL of a completed download for offline
   * playback. Returns null on Android (offline playback there replays the
   * remote HLS URL through ExoPlayer's CacheDataSource) or when not found.
   */
  async getOfflineUrl(id: string): Promise<string | null> {
    if (!DownloadNotification || !DownloadNotification.getOfflineUrl) return null;
    try {
      const result = await DownloadNotification.getOfflineUrl({ id });
      return result.url ?? null;
    } catch {
      return null;
    }
  }

  /** Update the copy on the iOS Live Activity tracking the download queue.
   *  Gated on the platform, not on the method existing: registerPlugin hands
   *  back a proxy that fabricates a wrapper for any name, so an Android call
   *  would cross the bridge only to be rejected as unimplemented. */
  setActivityCopy(copy: DownloadActivityCopy): void {
    if (!DownloadNotification || Capacitor.getPlatform() !== 'ios') return;
    DownloadNotification.setActivityCopy(copy).catch(() => {});
  }

  /** Cap how many transfers the native daemon runs at once. */
  setMaxConcurrentDownloads(max: number): void {
    if (!this.isNative || !DownloadNotification) return;
    DownloadNotification.setMaxConcurrentDownloads({ max }).catch(() => {});
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
