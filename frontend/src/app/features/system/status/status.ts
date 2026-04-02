import {
  Component, ChangeDetectionStrategy, signal, inject, OnInit,
} from '@angular/core';
import { DatePipe, NgClass, KeyValuePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { SseService } from '../../../core/services/sse.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';

interface CommandEntry { id: number; name: string; status: string; trigger: string; startedOn: string; endedOn?: string; }
interface ServiceStatus { name: string; ok: boolean; message?: string; }
interface HealthReport { version: string; uptimeSeconds: number; database: ServiceStatus; indexers: { enabled: number; total: number }; downloadClients: ServiceStatus[]; }

@Component({
  selector: 'app-system-status',
  imports: [TranslateModule, DatePipe, NgClass, KeyValuePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './status.html',
})
export class SystemStatusComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  readonly sse = inject(SseService);

  readonly health = signal<HealthReport | null>(null);
  readonly healthLoading = signal(true);
  readonly commands = signal<CommandEntry[]>([]);
  readonly commandsTotal = signal(0);
  readonly commandsPage = signal(1);
  readonly loading = signal(true);
  readonly triggering = signal<string | null>(null);

  readonly availableCommands = [
    { name: 'RssSync', label: 'system.cmd_rss_sync' },
    { name: 'SearchMissing', label: 'system.cmd_search_missing' },
    { name: 'RefreshMetadata', label: 'system.cmd_refresh_metadata' },
    { name: 'ImportCompleted', label: 'system.cmd_import_completed' },
  ];

  ngOnInit() {
    this.sse.connect();
    this.loadHealth();
    this.loadCommands();
  }

  async loadHealth() {
    this.healthLoading.set(true);
    try {
      this.health.set(await firstValueFrom(this.http.get<HealthReport>('/api/system/health')));
    } finally { this.healthLoading.set(false); }
  }

  async loadCommands(page = 1) {
    this.commandsPage.set(page);
    this.loading.set(true);
    try {
      const res = await firstValueFrom(
        this.http.get<{ data: CommandEntry[]; total: number }>('/api/commands', {
          params: { page: String(page), limit: '25' },
        }),
      );
      this.commands.set(res.data);
      this.commandsTotal.set(res.total);
    } finally { this.loading.set(false); }
  }

  get commandsTotalPages(): number {
    return Math.max(1, Math.ceil(this.commandsTotal() / 25));
  }

  async trigger(name: string) {
    this.triggering.set(name);
    try {
      await firstValueFrom(this.http.post<CommandEntry>('/api/commands', { name }));
      await this.loadCommands();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({ title: this.translate.instant('common.error'), message: httpErr.error?.message ?? this.translate.instant('system.trigger_error'), variant: 'danger' });
    } finally { this.triggering.set(null); }
  }

  formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}j ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  statusClass(status: string): string {
    switch (status) {
      case 'completed': return 'badge-success';
      case 'failed': return 'badge-error';
      case 'started': return 'badge-info';
      default: return 'badge-ghost';
    }
  }
}
