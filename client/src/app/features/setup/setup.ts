import {
  Component,
  ElementRef,
  signal,
  inject,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ServerConfigService, KnownServer } from '../../core/services/server-config.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';

/**
 * Bases to probe, in order. An http host that 301s to https is unusable from the
 * native app: the redirect carries no CORS headers, so the XHR dies before it can
 * be followed. Probing https directly is the only way to reach such a server.
 */
const PROBE_TIMEOUT_MS = 10_000;

export function withHttpsFallback(base: string): string[] {
  return base.startsWith('http://')
    ? [base, `https://${base.slice('http://'.length)}`]
    : [base];
}

@Component({
  selector: 'app-setup',
  imports: [FormsModule, TranslatePipe],
  templateUrl: './setup.html',
})
export class SetupComponent {
  private readonly serverConfig = inject(ServerConfigService);
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);

  readonly url = signal(this.serverConfig.serverUrl() || 'http://');
  readonly testing = signal(false);
  readonly testResult = signal<{ ok: boolean; message: string } | null>(null);
  readonly knownServers = this.serverConfig.knownServers;
  /** URL being switched to, or null. The app restarts on a server switch, so
   *  this only has to hold until then. */
  readonly switchingTo = signal<string | null>(null);
  /** True only for a switch started by the save button, so the recent-server
   *  rows don't spin its spinner. */
  readonly saving = signal(false);
  /** URL of the entry whose ⋯ menu is open, or null. */
  readonly openMenuFor = signal<string | null>(null);
  private readonly saveBtn = viewChild<ElementRef<HTMLButtonElement>>('saveBtn');

  async test() {
    const raw = this.url().trim().replace(/\/+$/, '');
    if (!raw) return;

    this.testing.set(true);
    this.testResult.set(null);
    try {
      for (const base of withHttpsFallback(raw)) {
        if (await this.reachable(base)) {
          this.url.set(base);
          this.testResult.set({ ok: true, message: 'setup.test_success' });
          // Save is disabled until the test passes — hand it the focus once
          // the render that enables it has happened, so the D-pad lands there.
          setTimeout(() => this.saveBtn()?.nativeElement.focus());
          return;
        }
      }
      this.testResult.set({ ok: false, message: 'setup.test_error' });
    } finally {
      this.testing.set(false);
    }
  }

  /** 401 counts as reachable: the server answered, we're just not logged in. */
  private async reachable(base: string): Promise<boolean> {
    try {
      await firstValueFrom(
        this.http.get(`${base}/api/auth/me`, { responseType: 'json' }).pipe(timeout(PROBE_TIMEOUT_MS)),
      );
      return true;
    } catch (err: unknown) {
      return (err as { status?: number })?.status === 401;
    }
  }

  async save() {
    const result = this.testResult();
    if (!result?.ok) return;
    this.saving.set(true);
    try {
      await this.switchTo(this.url().trim());
    } finally {
      this.saving.set(false);
    }
  }

  /** One-tap "use this server": probe it first, then resume its stored session if any. */
  async useKnown(server: KnownServer) {
    if (this.switchingTo()) return;
    this.switchingTo.set(server.url);
    const ok = await this.reachable(server.url);
    this.switchingTo.set(null);
    if (!ok) {
      this.toast.error(this.translate.instant('setup.test_error'));
      return;
    }
    await this.switchTo(server.url);
  }

  private async switchTo(url: string) {
    if (this.switchingTo()) return;
    this.switchingTo.set(url);
    try {
      await this.auth.switchToServer(url);
    } finally {
      this.switchingTo.set(null);
    }
  }

  /** Servers this device can sign into without a password. */
  hasSession(server: KnownServer): boolean {
    return this.auth.serversWithSession().has(server.url);
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
