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
import { TranslateModule } from '@ngx-translate/core';
import { ServerConfigService } from '../../core/services/server-config.service';

@Component({
  selector: 'app-setup',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './setup.html',
})
export class SetupComponent {
  private readonly serverConfig = inject(ServerConfigService);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  readonly url = signal(this.serverConfig.serverUrl() || 'http://');
  readonly testing = signal(false);
  readonly testResult = signal<{ ok: boolean; message: string } | null>(null);

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
    void this.router.navigate(['/login']);
  }
}
