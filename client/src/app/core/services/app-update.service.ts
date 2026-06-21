import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { DeviceService } from './device.service';
import { AuthService } from './auth.service';
import {
  desktopUpdaterOrNull,
  type DesktopUpdateStatus,
} from '../plugins/desktop-updater.bridge';

/** `desktop` = the Electron app updates itself; `server` = the connected
 *  server is behind the latest release (admin-only, informational); `none`. */
export type UpdateMode = 'desktop' | 'server' | 'none';

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateInfoView {
  version: string;
  releaseNotes: string | null;
  releaseUrl: string | null;
  releaseDate: string | null;
}

interface ServerUpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseNotes: string | null;
  publishedAt: string | null;
}

/** Drives the topbar update button + changelog modal: wraps the Electron
 *  updater on desktop, or the admin-only server-version check on web/mobile. */
@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  private readonly device = inject(DeviceService);
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);

  private readonly desktop = desktopUpdaterOrNull();

  readonly mode = computed<UpdateMode>(() => {
    if (this.device.isDesktopNative() && this.desktop) return 'desktop';
    if (this.auth.canAccessSettings()) return 'server';
    return 'none';
  });

  readonly state = signal<UpdateState>('idle');
  readonly info = signal<UpdateInfoView | null>(null);
  readonly progress = signal(0);
  /** False for .deb / dev (→ download link) and always false in server mode. */
  readonly canInstall = signal(false);
  readonly currentVersion = signal<string | null>(null);
  readonly releasesUrl = signal<string | null>(null);
  readonly errorMessage = signal<string | null>(null);

  /** Gate for showing the topbar update button. */
  readonly available = computed(
    () => this.state() === 'available' || this.state() === 'downloaded',
  );

  private serverChecked = false;

  constructor() {
    if (this.desktop) this.wireDesktop();

    // Server-mode check fires once the user is known to be an admin.
    effect(() => {
      if (this.mode() === 'server' && !this.serverChecked) {
        this.serverChecked = true;
        void this.checkServer();
      }
    });
  }

  /** Trigger a fresh check (used by a manual "check for updates" action). */
  async check(): Promise<void> {
    if (this.mode() === 'desktop') {
      await this.desktop?.check();
    } else if (this.mode() === 'server') {
      this.serverChecked = true;
      await this.checkServer();
    }
  }

  /** Desktop+installable → download & relaunch; otherwise open the release. */
  async install(): Promise<void> {
    if (this.mode() === 'desktop' && this.desktop) {
      if (this.canInstall()) {
        await this.desktop.install();
      } else {
        await this.desktop.openReleases();
      }
      return;
    }
    const url = this.info()?.releaseUrl ?? this.releasesUrl();
    if (url) window.open(url, '_blank', 'noopener');
  }

  private wireDesktop(): void {
    const updater = this.desktop!;
    void updater
      .getCapability()
      .then((cap) => {
        this.canInstall.set(cap.canInstall);
        this.currentVersion.set(cap.currentVersion);
        this.releasesUrl.set(cap.releasesUrl);
      })
      .catch(() => undefined);

    updater.onStatus((status) => this.applyDesktopStatus(status));
    void updater.check().catch(() => undefined);
  }

  private applyDesktopStatus(status: DesktopUpdateStatus): void {
    this.state.set(status.state);
    switch (status.state) {
      case 'available':
      case 'downloaded':
        this.info.set({
          version: status.info.version,
          releaseNotes: status.info.releaseNotes,
          releaseUrl: status.info.releaseUrl,
          releaseDate: status.info.releaseDate,
        });
        this.errorMessage.set(null);
        break;
      case 'downloading':
        this.progress.set(status.percent);
        break;
      case 'error':
        this.errorMessage.set(status.message);
        break;
    }
  }

  private async checkServer(): Promise<void> {
    this.state.set('checking');
    try {
      const status = await firstValueFrom(
        this.http.get<ServerUpdateStatus>('/api/system/update'),
      );
      this.currentVersion.set(status.currentVersion);
      this.releasesUrl.set(status.releaseUrl);
      if (status.updateAvailable && status.latestVersion) {
        this.info.set({
          version: status.latestVersion.replace(/^v/i, ''),
          releaseNotes: status.releaseNotes,
          releaseUrl: status.releaseUrl,
          releaseDate: status.publishedAt,
        });
        this.state.set('available');
      } else {
        this.state.set('not-available');
      }
    } catch {
      // A failed check is silent — no button, no toast.
      this.state.set('error');
    }
  }
}
