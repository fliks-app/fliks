import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { Capacitor } from '@capacitor/core';
import { firstValueFrom } from 'rxjs';
import { DeviceService } from './device.service';
import { AuthService } from './auth.service';
import { SKIP_ERROR_TOAST } from '../interceptors/error.interceptor';
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

const HIDE_UNTIL_KEY = 'fliks.updateHiddenForServer';
const NEVER_AHEAD_KEY = 'fliks.updateNeverAheadOfServer';

/** Numeric x.y.z compare, pre-release/build suffix dropped. */
function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => v.trim().replace(/^v/i, '').split(/[-+]/)[0].split('.').map(Number);
  const x = parse(a);
  const y = parse(b);
  if ([...x, ...y].some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the preference lasts for this session only */
  }
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
    // Native apps (iOS/Android/TV) update through their store — no in-app
    // update path, so the topbar update check doesn't apply there.
    if (Capacitor.isNativePlatform()) return 'none';
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

  /** Version of the connected server; desktop mode only. */
  readonly serverVersion = signal<string | null>(null);
  /** The desktop update would run a client newer than its server. */
  readonly aheadOfServer = computed(() => {
    const next = this.info()?.version;
    const server = this.serverVersion();
    return this.mode() === 'desktop' && !!next && !!server && isNewer(next, server);
  });
  /** Server version the user hid the topbar button for. */
  readonly hiddenForServer = signal(readPref(HIDE_UNTIL_KEY));
  readonly neverAheadOfServer = signal(readPref(NEVER_AHEAD_KEY) === 'true');

  /** The user chose to hide this update because the server is older. */
  readonly hiddenAhead = computed(
    () =>
      this.aheadOfServer() &&
      (this.neverAheadOfServer() || this.hiddenForServer() === this.serverVersion()),
  );

  /** Gate for showing the topbar update button. */
  readonly available = computed(
    () =>
      (this.state() === 'available' || this.state() === 'downloaded') && !this.hiddenAhead(),
  );

  private serverChecked = false;
  private serverVersionFetched = false;

  constructor() {
    if (this.desktop) this.wireDesktop();

    // Server-mode check fires once the user is known to be an admin.
    effect(() => {
      if (this.mode() === 'server' && !this.serverChecked) {
        this.serverChecked = true;
        void this.checkServer();
      }
    });

    effect(() => {
      if (this.mode() === 'desktop' && this.auth.user() && this.info() && !this.serverVersionFetched) {
        this.serverVersionFetched = true;
        void this.fetchServerVersion();
      }
    });
  }

  /** Hide the topbar button until the server moves off its current version. */
  hideUntilServerUpdates(): void {
    const v = this.serverVersion();
    this.hiddenForServer.set(v);
    writePref(HIDE_UNTIL_KEY, v);
  }

  setNeverAheadOfServer(on: boolean): void {
    this.neverAheadOfServer.set(on);
    writePref(NEVER_AHEAD_KEY, on ? 'true' : null);
  }

  /** Trigger a fresh check (used by a manual "check for updates" action). */
  async check(): Promise<void> {
    if (this.mode() === 'desktop') {
      if (this.auth.user()) void this.fetchServerVersion();
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

  private async fetchServerVersion(): Promise<void> {
    try {
      const { version } = await firstValueFrom(
        this.http.get<{ version: string }>('/api/system/version', {
          context: new HttpContext().set(SKIP_ERROR_TOAST, true),
        }),
      );
      this.serverVersion.set(version);
    } catch {
      // Unknown server version: never warn, never hide.
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
