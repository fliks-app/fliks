import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ServerConfigService, KnownServer } from '../../core/services/server-config.service';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-setup',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './setup.html',
})
export class SetupComponent {
  private readonly serverConfig = inject(ServerConfigService);
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);

  readonly url = signal(this.serverConfig.serverUrl() || 'http://');
  readonly testing = signal(false);
  readonly testResult = signal<{ ok: boolean; message: string } | null>(null);
  readonly knownServers = this.serverConfig.knownServers;
  /** URL of the entry whose ⋯ menu is open, or null. */
  readonly openMenuFor = signal<string | null>(null);

  async test() {
    const raw = this.url().trim().replace(/\/+$/, '');
    if (!raw) return;

    this.testing.set(true);
    this.testResult.set(null);
    try {
      // /api/auth/me returns 401 if not logged in, but proves the server is reachable
      await firstValueFrom(this.http.get(`${raw}/api/auth/me`, { responseType: 'json' }));
      this.testResult.set({ ok: true, message: 'setup.test_success' });
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      // 401 = server reachable but not authenticated — that's fine
      if (status === 401) {
        this.testResult.set({ ok: true, message: 'setup.test_success' });
      } else {
        this.testResult.set({ ok: false, message: 'setup.test_error' });
      }
    } finally {
      this.testing.set(false);
    }
  }

  async save() {
    const result = this.testResult();
    if (!result?.ok) return;
    await this.serverConfig.save(this.url().trim());
    // Drop the previous server's credentials so playback-info and every
    // streaming URL re-mint against the server just picked.
    await this.auth.resetForServerSwitch();
    void this.router.navigate(['/select-user']);
  }

  /** One-tap "use this server" — already known, skip the test step. */
  async useKnown(server: KnownServer) {
    await this.serverConfig.save(server.url);
    // Worst case for stale credentials: this path can skip login() entirely
    // when a session is still hydrated, so wipe the old server's tokens here.
    await this.auth.resetForServerSwitch();
    void this.router.navigate(['/select-user'], {
      queryParams: server.lastUsername ? { username: server.lastUsername } : undefined,
    });
  }

  toggleMenu(url: string, event: Event) {
    event.stopPropagation();
    this.openMenuFor.set(this.openMenuFor() === url ? null : url);
  }

  closeMenu() {
    this.openMenuFor.set(null);
  }

  async forget(server: KnownServer, event: Event) {
    event.stopPropagation();
    this.openMenuFor.set(null);
    await this.serverConfig.forgetKnownServer(server.url);
  }

  async rename(server: KnownServer, event: Event) {
    event.stopPropagation();
    this.openMenuFor.set(null);
    // window.prompt is rough but works on native (Capacitor proxies to a system
    // dialog) and on web. A polished modal can replace it later.
    const next = window.prompt(
      this.translate.instant('server_history.rename_prompt'),
      server.name ?? '',
    );
    if (next === null) return;
    await this.serverConfig.renameKnownServer(server.url, next);
  }

  /** Coarse human-readable freshness. */
  formatRelative(ts: number): string {
    const diffMs = Date.now() - ts;
    const min = Math.round(diffMs / 60000);
    if (min < 1) return this.translate.instant('server_history.relative.just_now');
    if (min < 60) return this.translate.instant('server_history.relative.minutes', { n: min });
    const hours = Math.round(min / 60);
    if (hours < 24) return this.translate.instant('server_history.relative.hours', { n: hours });
    const days = Math.round(hours / 24);
    return this.translate.instant('server_history.relative.days', { n: days });
  }
}
