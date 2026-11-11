import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Capacitor } from '@capacitor/core';
import { SKIP_ERROR_TOAST } from '../interceptors/error.interceptor';
import { AuthService } from './auth.service';
import { DeviceService } from './device.service';

/** Numeric x.y.z compare, pre-release/build suffix dropped. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => v.trim().replace(/^v/i, '').split(/[-+]/)[0].split('.').map(Number);
  const x = parse(a);
  const y = parse(b);
  if ([...x, ...y].some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/** A `-dev` server runs the newest code; an unknown version answers nothing new. */
export function serverSupports(server: string | null, since: string): boolean {
  return !!server && (server.endsWith('-dev') || !isNewer(since, server));
}

/** First release serving each route the client reads by itself (SSE connect, home, playback); 404 on an older server. */
export const SERVER_SINCE = {
  downloadProgress: '6.1.0',
  keepalive: '6.1.0',
  recentlyPlayed: '6.1.0',
  grabBest: '6.1.0',
  playlistM3u: '6.1.0',
  playlistPreview: '6.1.0',
} as const;

/** A failed version read is retried this many times, each after twice the previous delay. */
const RETRY_DELAYS_MS = [3_000, 6_000, 12_000, 24_000, 48_000];

/** Version of the connected server: an installed app can update before its server, so a feature added
 *  after the oldest supported server is gated with `supports('<release that added it>')`. */
@Injectable({ providedIn: 'root' })
export class ServerVersionService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly device = inject(DeviceService);
  /** A browser runs the build its server serves, so it never needs a gate. */
  private readonly web = !Capacitor.isNativePlatform() && !this.device.isTv() && !this.device.isDesktopNative();
  readonly version = signal<string | null>(null);
  private inflight: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;

  private readonly onUser = effect(() => {
    if (this.auth.user()) untracked(() => void this.refresh());
    else {
      this.version.set(null);
      this.stopRetrying();
    }
  });

  refresh(): Promise<void> {
    return (this.inflight ??= firstValueFrom(
      this.http.get<{ version: string }>('/api/system/version', {
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      }),
    ).then(
      ({ version }) => {
        this.version.set(version);
        this.stopRetrying();
      },
      () => {
        this.version.set(null);
        this.retryLater();
      },
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
    if (!this.web && !this.version()) await this.refresh();
    return this.supports(since);
  }
}
