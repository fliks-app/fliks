import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';

interface DownloadNotificationPlugin {
  show(opts: {
    id: number;
    title: string;
    text: string;
    progress: number;
    status: string;
  }): Promise<void>;
  dismiss(opts: { id: number }): Promise<void>;
  dismissAll(): Promise<void>;
  startService(): Promise<void>;
  stopService(): Promise<void>;
}

const DownloadNotification = registerPlugin<DownloadNotificationPlugin>('DownloadNotification');

@Injectable({ providedIn: 'root' })
export class DownloadNotificationService {
  private readonly isNative = Capacitor.isNativePlatform();
  private lastUpdateTime = new Map<number, number>();

  /**
   * Show or update a download notification.
   * Throttled to max 1 update per second per notification.
   */
  show(id: number, title: string, progress: number, status: string) {
    if (!this.isNative) return;

    // Throttle: max 1 update/s (except for complete/error which are always immediate)
    if (status !== 'complete' && status !== 'error') {
      const now = Date.now();
      const last = this.lastUpdateTime.get(id) ?? 0;
      if (now - last < 1000) return;
      this.lastUpdateTime.set(id, now);
    }

    const text = status === 'complete'
      ? '✓'
      : status === 'error'
        ? '✗'
        : `${progress}%`;

    DownloadNotification.show({ id, title, text, progress, status }).catch(() => {});
  }

  dismiss(id: number) {
    if (!this.isNative) return;
    this.lastUpdateTime.delete(id);
    DownloadNotification.dismiss({ id }).catch(() => {});
  }

  dismissAll() {
    if (!this.isNative) return;
    this.lastUpdateTime.clear();
    DownloadNotification.dismissAll().catch(() => {});
  }

  /** Start foreground service to keep downloads alive in background */
  startService() {
    if (!this.isNative) return;
    DownloadNotification.startService().catch(() => {});
  }

  /** Stop foreground service when no more active downloads */
  stopService() {
    if (!this.isNative) return;
    DownloadNotification.stopService().catch(() => {});
  }
}
