import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { isUnreachable, SKIP_ERROR_TOAST } from '../interceptors/error.interceptor';
import { IS_STANDALONE_BUNDLE, restartApp } from '../utils/standalone-bundle';

export type ServerDown = 'restarting' | 'upgrading';

const POLL_MS = 2000;

/** Blocks the app while the active server is down for a restart, then reloads it once the server answers. */
@Injectable({ providedIn: 'root' })
export class ServerBootService {
  private readonly http = inject(HttpClient);
  readonly down = signal<ServerDown | null>(null);
  private polling = false;
  private dismissed = false;

  /** `upgrading` sticks: a restart that turns into a migration keeps saying so. */
  waitAndReload(state: ServerDown): void {
    if (this.dismissed) return;
    if (this.down() !== 'upgrading') this.down.set(state);
    if (this.polling) return;
    this.polling = true;
    void this.poll();
  }

  /** Leaves the app usable offline (downloads) until the server is back, then lets it reconnect in place. */
  dismiss(): void {
    this.dismissed = true;
    this.down.set(null);
  }

  private async poll(): Promise<void> {
    const context = new HttpContext().set(SKIP_ERROR_TOAST, true);
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      try {
        // Public and cheap: answers once the app is published, signed in or not.
        await firstValueFrom(this.http.get('/api/auth/setup', { context }));
        break;
      } catch (err) {
        if (!(err instanceof HttpErrorResponse && isUnreachable(err))) break;
      }
    }
    if (this.dismissed) {
      this.polling = this.dismissed = false;
      return;
    }
    if (IS_STANDALONE_BUNDLE) restartApp();
    else location.reload();
  }
}
