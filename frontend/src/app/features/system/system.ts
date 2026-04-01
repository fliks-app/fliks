import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  OnInit,
  OnDestroy,
} from '@angular/core';
import { DatePipe, NgClass, KeyValuePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { SseService } from '../../core/services/sse.service';
import { ConfirmationService } from '../../core/services/confirmation.service';

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
  imports: [TranslateModule, DatePipe, NgClass, FormsModule, KeyValuePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './system.html',
})
export class SystemComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  readonly sse = inject(SseService);

  readonly health = signal<HealthReport | null>(null);
  readonly healthLoading = signal(true);

  readonly commands = signal<CommandEntry[]>([]);
  readonly loading = signal(true);
  readonly triggering = signal<string | null>(null);

  readonly backups = signal<{ filename: string; size: number; date: string }[]>([]);
  readonly backupsLoading = signal(false);
  readonly backupCreating = signal(false);

  readonly logs = signal<{ timestamp: string; level: string; context: string; message: string }[]>([]);
  readonly logsLoading = signal(false);
  readonly logLevel = signal('');
  readonly logSearch = signal('');
  private logInterval: any;

  readonly importRadarrLoading = signal(false);
  readonly importSonarrLoading = signal(false);
  readonly importResult = signal<{ imported: number; skipped: number; errors: string[] } | null>(null);

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
    this.loadBackups();
    this.loadLogs();
    this.logInterval = setInterval(() => this.loadLogs(), 5000);
  }

  ngOnDestroy() {
    clearInterval(this.logInterval);
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

  async loadLogs() {
    this.logsLoading.set(true);
    try {
      const params: Record<string, string> = {};
      if (this.logLevel()) params['level'] = this.logLevel();
      if (this.logSearch()) params['q'] = this.logSearch();
      params['limit'] = '200';
      const entries = await firstValueFrom(this.http.get<any[]>('/api/system/logs', { params }));
      this.logs.set(entries);
    } finally {
      this.logsLoading.set(false);
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
      void this.confirmation.alert({ title: this.translate.instant('common.error'), message: httpErr.error?.message ?? this.translate.instant('system.trigger_error'), variant: 'danger' });
    } finally {
      this.triggering.set(null);
    }
  }

  async loadBackups() {
    this.backupsLoading.set(true);
    try {
      const list = await firstValueFrom(this.http.get<{ filename: string; size: number; date: string }[]>('/api/system/backups'));
      this.backups.set(list);
    } finally {
      this.backupsLoading.set(false);
    }
  }

  async createBackup() {
    this.backupCreating.set(true);
    try {
      await firstValueFrom(this.http.post('/api/system/backup', {}));
      await this.loadBackups();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({ title: this.translate.instant('common.error'), message: httpErr.error?.message ?? 'Backup failed', variant: 'danger' });
    } finally {
      this.backupCreating.set(false);
    }
  }

  async restoreBackup(filename: string) {
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: this.translate.instant('system.confirm_restore'), variant: 'warning' })) return;
    try {
      await firstValueFrom(this.http.post('/api/system/restore', { filename }));
      void this.confirmation.alert({ title: this.translate.instant('common.success'), message: this.translate.instant('system.restore_ok'), variant: 'info' });
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({ title: this.translate.instant('common.error'), message: httpErr.error?.message ?? 'Restore failed', variant: 'danger' });
    }
  }

  async importRadarr(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.importRadarrLoading.set(true);
    this.importResult.set(null);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const result = await firstValueFrom(this.http.post<{ imported: number; skipped: number; errors: string[] }>('/api/system/import-radarr', formData));
      this.importResult.set(result);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.importResult.set({ imported: 0, skipped: 0, errors: [httpErr.error?.message ?? 'Import failed'] });
    } finally {
      this.importRadarrLoading.set(false);
    }
  }

  async importSonarr(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.importSonarrLoading.set(true);
    this.importResult.set(null);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const result = await firstValueFrom(this.http.post<{ imported: number; skipped: number; errors: string[] }>('/api/system/import-sonarr', formData));
      this.importResult.set(result);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.importResult.set({ imported: 0, skipped: 0, errors: [httpErr.error?.message ?? 'Import failed'] });
    } finally {
      this.importSonarrLoading.set(false);
    }
  }

  formatBytes(bytes: number): string {
    if (!bytes || bytes < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
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
