import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Capacitor } from '@capacitor/core';
import { SKIP_ERROR_TOAST } from '../interceptors/error.interceptor';
import { AuthService } from './auth.service';
import { DeviceService } from './device.service';
import { ServerConfigService } from './server-config.service';
import { compareVersions, releaseOf } from '../utils/semver';
import { readStored, writeStored } from '../utils/local-flag';

/** A `-dev` server runs the newest code; an unknown version answers nothing new. */
export function serverSupports(server: string | null, since: string): boolean {
  return !!server && (server.endsWith('-dev') || compareVersions(since, releaseOf(server)) <= 0);
}

/** First release serving each route the client reads by itself (SSE connect, home, playback); 404 on an older server. */
export const SERVER_SINCE = {
  downloadProgress: '7.0.0',
  keepalive: '7.0.0',
  recentlyPlayed: '7.0.0',
  grabBest: '7.0.0',
  playlistM3u: '7.0.0',
  playlistPreview: '7.0.0',
  listWithoutTotal: '7.0.0',
  stemPcm: '7.0.0',
  whatsNew: '7.0.0',
  acquisitionQueue: '7.0.0',
  optimize: '7.0.0',
  acquisitionSettings: '7.0.0',
  lyrics: '7.0.0',
  karaoke: '7.0.0',
  sessionSync: '7.0.0',
  push: '7.1.0',
  liveTvGroups: '7.1.1',
  // Release that carries the engine keyframes-route fix.
  keyframes: '7.1.1',
} as const;

/** A failed version read is retried this many times, each after twice the previous delay. */
const RETRY_DELAYS_MS = [3_000, 6_000, 12_000, 24_000, 48_000];
const STORAGE_PREFIX = 'fliks.serverVersion::';

/** Version of the connected server: an installed app can update before its server, so a feature added
 *  after the oldest supported server is gated with `supports('<release that added it>')`. */
@Injectable({ providedIn: 'root' })
export class ServerVersionService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly device = inject(DeviceService);
  private readonly serverConfig = inject(ServerConfigService);
  /** A browser runs the build its server serves, so it never needs a gate. */
  private readonly web = !Capacitor.isNativePlatform() && !this.device.isTv() && !this.device.isDesktopNative();
  readonly version = signal<string | null>(null);
  private inflight: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;

  private readonly onUser = effect(() => {
    if (this.auth.user())
      untracked(() => {
        this.version.set(this.stored());
        void this.refresh();
      });
    else {
      this.version.set(null);
      this.stopRetrying();
    }
  });

  refresh(): Promise<void> {
    const key = this.storageKey();
    return (this.inflight ??= firstValueFrom(
      this.http.get<{ version: string }>('/api/system/version', {
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      }),
    ).then(
      ({ version }) => {
        this.version.set(version);
        writeStored(key, version);
        this.stopRetrying();
      },
      // The last known version stays: the link is down, not the server replaced.
      () => this.retryLater(),
    ).finally(() => (this.inflight = null)));
  }

  /** A server that was unreachable at login would otherwise leave every gate shut until the next login. */
  private retryLater(): void {
    const delay = RETRY_DELAYS_MS[this.attempt++];
    if (delay === undefined || this.retryTimer || !this.auth.user()) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.refresh();
    }, delay);
  }

  private stopRetrying(): void {
    this.attempt = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  supports(since: string): boolean {
    return this.web || serverSupports(this.version(), since);
  }

  /** `supports` for a call that can run before the first version request has answered. */
  async supportsWhenKnown(since: string): Promise<boolean> {
    if (!this.web && !this.version()) {
      const known = this.stored();
      if (!known) await this.refresh();
      else {
        this.version.set(known);
        void this.refresh();
      }
    }
    return this.supports(since);
  }

  /** Last version this server answered, so a cold start gates without a round trip. */
  private stored(): string | null {
    return readStored(this.storageKey());
  }

  private storageKey(): string {
    return STORAGE_PREFIX + untracked(this.serverConfig.serverUrl);
  }
}
