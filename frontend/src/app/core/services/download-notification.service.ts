import { Injectable, signal } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';

export interface NativeDownloadEvent {
  type: 'progress' | 'ready' | 'failed' | 'complete';
  taskId: number;
  progress: number;
  status: string;
  /** Monotonic counter — ensures every event is unique for signal change detection */
  seq: number;
}

interface DownloadNotificationPlugin {
  show(opts: { id: number; title: string; text: string; progress: number; status: string; episode?: string }): Promise<void>;
  dismiss(opts: { id: number }): Promise<void>;
  dismissAll(): Promise<void>;
  startService(): Promise<void>;
  stopService(): Promise<void>;
  setPollingConfig(opts: {
    baseUrl: string; token: string; taskId: number; title: string;
    episode?: string; fileUrl: string; destPath: string; expectedSize: number;
  }): Promise<void>;
  clearPolling(): Promise<void>;
  nativeDownload(opts: { url: string; token: string; destPath: string; expectedSize: number; title: string; taskId: number }): Promise<void>;
  getActiveTasks(): Promise<{ tasks: string }>;
  addListener(event: string, cb: (data: any) => void): Promise<any>;
}

const DownloadNotification = Capacitor.isNativePlatform()
  ? registerPlugin<DownloadNotificationPlugin>('DownloadNotification')
  : null;

/**
 * Platform-agnostic download notification service.
 * Android: native foreground service + notifications + WebView event bridge.
 * iOS/Web: no-op (future: iOS UserNotifications).
 */
@Injectable({ providedIn: 'root' })
export class DownloadNotificationService {
  private readonly isAndroid = Capacitor.getPlatform() === 'android';
  private lastUpdateTime = new Map<number, number>();

  /** Native events from Java service → WebView (Android only) */
  readonly nativeEvent = signal<NativeDownloadEvent | null>(null);
  private eventSeq = 0;

  constructor() {
    if (DownloadNotification) {
      const handle = (type: NativeDownloadEvent['type']) =>
        (data: { taskId: number; progress: number; status: string }) => {
          this.nativeEvent.set({
            type, taskId: data.taskId, progress: data.progress,
            status: data.status, seq: ++this.eventSeq,
          });
        };
      DownloadNotification.addListener('downloadProgress', handle('progress'));
      DownloadNotification.addListener('downloadReady', handle('ready'));
      DownloadNotification.addListener('downloadFailed', handle('failed'));
      DownloadNotification.addListener('downloadComplete', handle('complete'));
    }
  }

  /**
   * Show or update a download notification.
   * Throttled to 1 update/sec for in-progress states.
   */
  show(id: number, title: string, progress: number, status: string, episode?: string) {
    if (!DownloadNotification) return;

    if (status !== 'complete' && status !== 'error') {
      const now = Date.now();
      const last = this.lastUpdateTime.get(id) ?? 0;
      if (now - last < 1000) return;
      this.lastUpdateTime.set(id, now);
    }

    const text = status === 'complete' ? '✓' : status === 'error' ? '✗' : `${progress}%`;
    DownloadNotification.show({ id, title, text, progress, status, episode }).catch(() => {});
  }

  dismiss(id: number) {
    if (!DownloadNotification) return;
    this.lastUpdateTime.delete(id);
    DownloadNotification.dismiss({ id }).catch(() => {});
  }

  dismissAll() {
    if (!DownloadNotification) return;
    this.lastUpdateTime.clear();
    DownloadNotification.dismissAll().catch(() => {});
  }

  startService() {
    if (!this.isAndroid || !DownloadNotification) return;
    DownloadNotification.startService().catch(() => {});
  }

  stopService() {
    if (!this.isAndroid || !DownloadNotification) return;
    DownloadNotification.stopService().catch(() => {});
  }

  /**
   * Start native polling + pre-configure download URL for automatic chaining.
   * When transcode completes, Java service chains directly to native download.
   */
  startPolling(
    baseUrl: string, token: string, taskId: number, title: string,
    episode: string | undefined, fileUrl: string, destPath: string, expectedSize: number,
  ) {
    if (!this.isAndroid || !DownloadNotification) return;
    DownloadNotification.setPollingConfig({
      baseUrl, token, taskId, title, episode, fileUrl, destPath, expectedSize,
    }).catch(() => {});
  }

  stopPolling() {
    if (!this.isAndroid || !DownloadNotification) return;
    DownloadNotification.clearPolling().catch(() => {});
  }

  /**
   * Download a file natively with progress notification (Android only).
   * Runs in Java foreground service — survives WebView freeze.
   * On iOS/web: returns false (caller should use JS download instead).
   */
  /**
   * Get all active task states from Java service (single source of truth).
   * Used to sync WebView UI after visibility change / events loss.
   */
  async getActiveTasks(): Promise<{ taskId: number; progress: number; status: string }[]> {
    if (!DownloadNotification) return [];
    try {
      const result = await DownloadNotification.getActiveTasks();
      return JSON.parse(result.tasks);
    } catch {
      return [];
    }
  }

  nativeDownload(url: string, token: string, destPath: string, expectedSize: number, title: string, taskId: number): boolean {
    if (!this.isAndroid || !DownloadNotification) return false;
    DownloadNotification.nativeDownload({ url, token, destPath, expectedSize, title, taskId }).catch(() => {});
    return true;
  }
}
