import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  OnInit,
} from '@angular/core';
import { DatePipe, NgClass } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';

interface CommandEntry {
  id: number;
  name: string;
  status: string;
  trigger: string;
  startedOn: string;
  endedOn?: string;
}

interface ServiceStatus {
  name: string;
  ok: boolean;
  message?: string;
}

interface HealthReport {
  version: string;
  uptimeSeconds: number;
  database: ServiceStatus;
  indexers: { enabled: number; total: number };
  downloadClients: ServiceStatus[];
}

@Component({
  selector: 'app-system',
  imports: [TranslateModule, DatePipe, NgClass],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './system.html',
})
export class SystemComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);

  readonly health = signal<HealthReport | null>(null);
  readonly healthLoading = signal(true);

  readonly commands = signal<CommandEntry[]>([]);
  readonly loading = signal(true);
  readonly triggering = signal<string | null>(null);

  readonly availableCommands = [
    { name: 'RssSync', label: 'system.cmd_rss_sync' },
    { name: 'SearchMissing', label: 'system.cmd_search_missing' },
    { name: 'RefreshMetadata', label: 'system.cmd_refresh_metadata' },
    { name: 'ImportCompleted', label: 'system.cmd_import_completed' },
  ];

  ngOnInit() {
    this.loadHealth();
    this.loadCommands();
  }

  async loadHealth() {
    this.healthLoading.set(true);
    try {
      const report = await firstValueFrom(this.http.get<HealthReport>('/api/system/health'));
      this.health.set(report);
    } finally {
      this.healthLoading.set(false);
    }
  }

  formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}j ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  async loadCommands() {
    this.loading.set(true);
    try {
      const cmds = await firstValueFrom(this.http.get<CommandEntry[]>('/api/commands'));
      this.commands.set(cmds);
    } finally {
      this.loading.set(false);
    }
  }

  async trigger(name: string) {
    this.triggering.set(name);
    try {
      await firstValueFrom(this.http.post<CommandEntry>('/api/commands', { name }));
      await this.loadCommands();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      alert(httpErr.error?.message ?? this.translate.instant('system.trigger_error'));
    } finally {
      this.triggering.set(null);
    }
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
