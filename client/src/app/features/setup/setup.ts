import {
  Component,
  ElementRef,
  signal,
  inject,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { NEVER, Observable, Subject, firstValueFrom, takeUntil, timeout } from 'rxjs';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ModalHeaderComponent } from '../../shared/components/modal-header';
import { ModalFooterComponent } from '../../shared/components/modal-footer';
import { ServerConfigService, KnownServer } from '../../core/services/server-config.service';
import { AuthService } from '../../core/services/auth.service';
import { SessionStoreService } from '../../core/services/session-store.service';
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
  imports: [FormsModule, TranslatePipe, ModalHeaderComponent, ModalFooterComponent],
  templateUrl: './setup.html',
})
export class SetupComponent {
  private readonly serverConfig = inject(ServerConfigService);
  private readonly auth = inject(AuthService);
  private readonly sessions = inject(SessionStoreService);
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
  private readonly editDialog = viewChild<ElementRef<HTMLDialogElement>>('editDialog');
  /** Server the edit dialog changes. */
  readonly editing = signal<KnownServer | null>(null);
  readonly editName = signal('');
  readonly editUrl = signal('');
  private testRun = 0;
  private readonly cancelTest$ = new Subject<void>();

  /** Editing the URL drops any running test and its now-stale result. */
  onUrlChange(value: string) {
    this.url.set(value);
    this.testRun++;
    this.cancelTest$.next();
    this.testing.set(false);
    this.testResult.set(null);
  }

  async test() {
    const raw = this.url().trim().replace(/\/+$/, '');
    if (!raw) return;

    const run = ++this.testRun;
    this.testing.set(true);
    this.testResult.set(null);
    try {
      for (const base of withHttpsFallback(raw)) {
        const ok = await this.reachable(base, this.cancelTest$);
        if (run !== this.testRun) return;
        if (ok) {
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
      if (run === this.testRun) this.testing.set(false);
    }
  }

  /** 401 counts as reachable: the server answered, we're just not logged in. */
  private async reachable(base: string, cancel$: Observable<void> = NEVER): Promise<boolean> {
    try {
      await firstValueFrom(
        this.http
          .get(`${base}/api/auth/me`, { responseType: 'json' })
          .pipe(timeout(PROBE_TIMEOUT_MS), takeUntil(cancel$)),
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

  edit(server: KnownServer, event: Event) {
    event.stopPropagation();
    this.openMenuFor.set(null);
    this.editing.set(server);
    this.editName.set(server.name ?? '');
    this.editUrl.set(server.url);
    this.editDialog()?.nativeElement.showModal();
  }

  closeEdit() {
    this.editDialog()?.nativeElement.close();
  }

  async confirmEdit() {
    const server = this.editing();
    if (!server) return;
    const url = await this.serverConfig.updateKnownServer(server.url, { name: this.editName(), url: this.editUrl() });
    await this.sessions.moveServer(server.url, url);
    this.closeEdit();
    if (server.url === this.serverConfig.serverUrl() && url !== server.url) await this.switchTo(url);
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
