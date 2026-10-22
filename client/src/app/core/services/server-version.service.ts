import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { SKIP_ERROR_TOAST } from '../interceptors/error.interceptor';
import { AuthService } from './auth.service';

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

/** A server at least as new as the app answers everything the app calls; an unknown version answers nothing new. */
export function serverSupports(server: string | null, since: string, app: string): boolean {
  return !!server && (!isNewer(since, server) || !isNewer(app, server));
}

/** Version of the connected server: an installed app can update before its server, so a feature added
 *  after the oldest supported server is gated with `supports('<release that added it>')`. */
@Injectable({ providedIn: 'root' })
export class ServerVersionService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  readonly version = signal<string | null>(null);
  private inflight: Promise<void> | null = null;

  private readonly onUser = effect(() => {
    if (this.auth.user()) untracked(() => void this.refresh());
    else this.version.set(null);
  });

  refresh(): Promise<void> {
    return (this.inflight ??= firstValueFrom(
      this.http.get<{ version: string }>('/api/system/version', {
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      }),
    ).then(
      ({ version }) => this.version.set(version),
      () => this.version.set(null),
    ).finally(() => (this.inflight = null)));
  }

  supports(since: string): boolean {
    return serverSupports(this.version(), since, environment.version);
  }

  /** `supports` for a call that can run before the first version request has answered. */
  async supportsWhenKnown(since: string): Promise<boolean> {
    if (!this.version()) await this.refresh();
    return this.supports(since);
  }
}
