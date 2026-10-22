import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { Capacitor, registerPlugin } from '@capacitor/core';

export interface NativeDownloadEvent {
  type: 'progress' | 'complete' | 'failed' | 'removed';
  id: string;
  progress: number;
  state: string;
}

/** Pre-translated notification copy shown by the native download daemon (iOS),
 *  on the completion banner and on the download's Live Activity. */
export interface DownloadNotifStrings {
  notifTitle: string;
  notifProgress: string;
  notifStale: string;
  notifComplete: string;
  notifFailed: string;
}

/** Pre-translated copy for the iOS Live Activity covering the download queue.
 *  The native side owns the numbers; only the wording comes from here. */
export interface DownloadActivityCopy {
  /** Media title for a lone download, a count for a batch. */
  headline: string;
  detail: string;
  /** Replaces `detail` once the system flags the content as out of date. */
  stale: string;
  complete: string;
  failed: string;
}

/** Pre-translated wording of the Android download notifications; `%d` and `%s` are filled natively. */
export interface DownloadNotificationCopy {
  channelName: string;
  channelDescription: string;
  progress: string;
  paused: string;
  complete: string;
  failed: string;
  /** Headline of a batch, `%d` the count. */
  activeCount: string;
  /** `%s` the remaining time. */
  timeLeft: string;
  pause: string;
  resume: string;
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
  pauseDownload(opts: { id: string }): Promise<void>;
  resumeDownload(opts: { id: string }): Promise<void>;
  setActivityCopy(opts: DownloadActivityCopy): Promise<void>;
  setNotificationCopy(opts: DownloadNotificationCopy): Promise<void>;
  setMaxConcurrentDownloads(opts: { max: number }): Promise<void>;
  setWifiOnly(opts: { enabled: boolean }): Promise<void>;
  dismissActivity(): Promise<void>;
  getDownloadSize(opts: { id: string }): Promise<{ bytes: number }>;
  addListener(event: string, cb: (data: any) => void): Promise<any>;
}

const DownloadNotification = Capacitor.isNativePlatform()
  ? registerPlugin<DownloadNotificationPlugin>('DownloadNotification')
  : null;

/** Bridge to the native ExoPlayer DownloadManager (Android) / AVAssetDownloadTask (iOS); no-op on web (Shaka offline). */
@Injectable({ providedIn: 'root' })
export class DownloadNotificationService {
  private readonly isNative = Capacitor.isNativePlatform();

  /** Every native event: Media3 fires one per download in the same tick on pause, which a last-value signal would collapse. */
  readonly nativeEvents = new Subject<NativeDownloadEvent>();

  constructor() {
    if (DownloadNotification) {
      const emit = (type: NativeDownloadEvent['type']) =>
        (data: { id: string; progress: number; state: string }) => {
          this.nativeEvents.next({ type, id: data.id, progress: data.progress, state: data.state });
        };
      DownloadNotification.addListener('downloadProgress', emit('progress'));
      DownloadNotification.addListener('downloadComplete', emit('complete'));
      DownloadNotification.addListener('downloadFailed', emit('failed'));
      DownloadNotification.addListener('downloadRemoved', emit('removed'));
    }
  }

  /** Starts an HLS download via the native manager; `notif` is pre-translated banner copy (iOS) and the notification title (Android). */
  startDownload(id: string, hlsUrl: string, token: string, notif?: DownloadNotifStrings): void {
    if (!this.isNative || !DownloadNotification) return;
    DownloadNotification.startDownload({ id, hlsUrl, token, ...(notif ?? {}) }).catch(() => {});
  }

  /** iOS: local `file://` URL of a completed download; null on Android (replays the remote HLS URL via ExoPlayer cache) or when not found. */
  async getOfflineUrl(id: string): Promise<string | null> {
    if (!DownloadNotification || !DownloadNotification.getOfflineUrl) return null;
    try {
      const result = await DownloadNotification.getOfflineUrl({ id });
      return result.url ?? null;
    } catch {
      return null;
    }
  }

  /** Updates the iOS Live Activity copy; gated on platform since registerPlugin's proxy fabricates any method and Android would reject it. */
  setActivityCopy(copy: DownloadActivityCopy): void {
    if (!DownloadNotification || Capacitor.getPlatform() !== 'ios') return;
    DownloadNotification.setActivityCopy(copy).catch(() => {});
  }

  /** Android: wording of the download notifications; gated like {@link setActivityCopy}. */
  setNotificationCopy(copy: DownloadNotificationCopy): void {
    if (!DownloadNotification || Capacitor.getPlatform() !== 'android') return;
    DownloadNotification.setNotificationCopy(copy).catch(() => {});
  }

  /** Retire the iOS Live Activity for the download queue. */
  dismissActivity(): void {
    if (!DownloadNotification || Capacitor.getPlatform() !== 'ios') return;
    DownloadNotification.dismissActivity().catch(() => {});
  }

  /** Cap how many transfers the native daemon runs at once. */
  setMaxConcurrentDownloads(max: number): void {
    if (!this.isNative || !DownloadNotification) return;
    DownloadNotification.setMaxConcurrentDownloads({ max }).catch(() => {});
  }

  /** Android applies it at once; iOS reads it when the background session is next built (app launch). */
  setWifiOnly(enabled: boolean): void {
    if (!this.isNative || !DownloadNotification) return;
    DownloadNotification.setWifiOnly({ enabled }).catch(() => {});
  }

  /** Hold one transfer; the daemon keeps what it has and reports it `paused`. */
  async pauseDownload(id: string): Promise<void> {
    if (!this.isNative || !DownloadNotification) return;
    await DownloadNotification.pauseDownload({ id }).catch(() => {});
  }

  async resumeDownload(id: string): Promise<void> {
    if (!this.isNative || !DownloadNotification) return;
    await DownloadNotification.resumeDownload({ id }).catch(() => {});
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

  /** Bytes a completed download occupies on device, or 0 when it isn't there. */
  async getDownloadSize(id: string): Promise<number> {
    if (!this.isNative || !DownloadNotification) return 0;
    try {
      return (await DownloadNotification.getDownloadSize({ id })).bytes ?? 0;
    } catch {
      return 0;
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
