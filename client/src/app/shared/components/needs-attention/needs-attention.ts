import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideCircleAlert, LucideCircleCheck, LucideTriangleAlert } from '@lucide/angular';
import { LocaleDatePipe } from '../../../core/pipes/locale-date.pipe';
import { SystemChecksApiService, SystemChecksReport } from '../../../core/services/api/system-checks-api.service';

const KNOWN_CODES = new Set([
  'plugin_failed',
  'plugin_degraded',
  'library_unmounted',
  'library_read_only',
  'space_low',
  'conf_volatile',
  'data_volatile',
  'job_failed',
]);

@Component({
  selector: 'app-needs-attention',
  imports: [RouterLink, TranslatePipe, LocaleDatePipe, LucideCircleAlert, LucideCircleCheck, LucideTriangleAlert],
  templateUrl: './needs-attention.html',
})
export class NeedsAttentionComponent implements OnInit {
  private readonly api = inject(SystemChecksApiService);

  readonly report = signal<SystemChecksReport | null>(null);
  readonly running = signal(false);

  async ngOnInit() {
    try {
      this.report.set(await this.api.get());
    } catch {
      // handled by global interceptor
    }
  }

  async run() {
    this.running.set(true);
    try {
      this.report.set(await this.api.run());
    } catch {
      // handled by global interceptor
    } finally {
      this.running.set(false);
    }
  }

  textKey(code: string): string {
    return KNOWN_CODES.has(code) ? `system.checks.${code}` : 'system.checks.unknown';
  }
}
