import {
  Component, ChangeDetectionStrategy, signal, inject, OnInit, effect,
} from '@angular/core';
import { DecimalPipe, NgClass, KeyValuePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { LucideTrash2 } from '@lucide/angular';
import { SseService } from '../../../core/services/sse.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { PaginationComponent } from '../../../shared/components/pagination/pagination';
import { DropdownMenuComponent } from '../../../shared/components/dropdown-menu';
import { LocaleDatePipe } from '../../../core/pipes/locale-date.pipe';

interface CommandEntry { id: number; name: string; status: string; trigger: string; startedOn: string; endedOn?: string; body?: Record<string, unknown>; }
interface ServiceStatus { name: string; ok: boolean; message?: string; }
interface HealthReport { version: string; uptimeSeconds: number; database: ServiceStatus; installedPlugins: number; restartSupervisor: string | null; }

@Component({
  selector: 'app-system-status',
  imports: [TranslateModule, LocaleDatePipe, DecimalPipe, NgClass, KeyValuePipe, LucideTrash2, PaginationComponent, DropdownMenuComponent],
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
  readonly clearing = signal(false);
  readonly restarting = signal(false);

  readonly commandItems: (
    | { type: 'single'; name: string; label: string }
    | { type: 'group'; label: string; items: { name: string; label: string }[] }
  )[] = [
    { type: 'group', label: 'system.cmd_group_media', items: [
      { name: 'SearchMissing', label: 'system.cmd_search_missing' },
      { name: 'RssSync', label: 'system.cmd_rss_sync' },
      { name: 'ImportCompleted', label: 'system.cmd_import_completed' },
    ]},
    { type: 'group', label: 'system.cmd_group_metadata', items: [
      { name: 'RefreshMetadata', label: 'system.cmd_refresh_metadata' },
      { name: 'RefreshMissingMetadata', label: 'system.cmd_refresh_missing_metadata' },
    ]},
    { type: 'group', label: 'system.cmd_group_subtitle', items: [
      { name: 'SubtitleSearch', label: 'system.cmd_subtitle_search' },
      { name: 'SubtitleUpgrade', label: 'system.cmd_subtitle_upgrade' },
    ]},
    { type: 'group', label: 'system.cmd_group_rescan', items: [
      { name: 'RescanAll', label: 'system.cmd_rescan_all' },
      { name: 'RescanMissingFiles', label: 'system.cmd_rescan_missing_files' },
    ]},
    { type: 'group', label: 'system.cmd_group_sprites', items: [
      { name: 'GenerateSprites', label: 'system.cmd_generate_sprites' },
      { name: 'GenerateMissingSprites', label: 'system.cmd_generate_missing_sprites' },
    ]},
    { type: 'group', label: 'system.cmd_group_markers', items: [
      { name: 'DetectMarkers', label: 'system.cmd_detect_markers' },
      { name: 'DetectMissingMarkers', label: 'system.cmd_detect_missing_markers' },
    ]},
  ];

  /** Flat list for label lookups in command history. */
  readonly availableCommands = [
    ...this.commandItems.flatMap(item =>
      item.type === 'single' ? [item] : item.items,
    ),
    // Non-triggerable commands (background-only) that still appear in history.
    { name: 'IntroDetection', label: 'system.cmd_intro_detection' },
  ];

  constructor() {
    effect(() => {
      const event = this.sse.lastEvent();
      if (event?.type === 'command.started' || event?.type === 'command.completed') {
        this.loadCommands(this.commandsPage());
      }
    });
  }

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

  async clearHistory() {
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('system.clear_history'),
      message: this.translate.instant('system.clear_history_confirm'),
      variant: 'danger',
    });
    if (!confirmed) return;
    this.clearing.set(true);
    try {
      await firstValueFrom(
        this.http.delete<{ deleted: number }>('/api/commands/history'),
      );
      await this.loadCommands();
    } finally {
      this.clearing.set(false);
    }
  }

  async restart() {
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('system.restart_server'),
      message: this.translate.instant('system.restart_confirm'),
      variant: 'danger',
    });
    if (!confirmed) return;
    this.restarting.set(true);
    try {
      await firstValueFrom(this.http.post('/api/system/restart', {}));
    } catch {
      this.restarting.set(false);
      return;
    }
    await this.waitForServer();
    location.reload();
  }

  private async waitForServer() {
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        await firstValueFrom(this.http.get('/api/system/health'));
        return;
      } catch {
        // Still down — keep polling.
      }
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

  statusClass(status: string): string {
    switch (status) {
      case 'completed': return 'badge-success';
      case 'failed': return 'badge-error';
      case 'started': return 'badge-info';
      default: return 'badge-ghost';
    }
  }

  /** i18n key for known scheduler commands (progress bar + consistency with manual actions). */
  commandLabelKey(commandName: string): string {
    const baseName = commandName.split(':')[0];
    return this.availableCommands.find((c) => c.name === baseName)?.label ?? commandName;
  }
}
