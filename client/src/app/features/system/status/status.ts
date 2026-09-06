import {
  Component, signal, inject, OnInit, OnDestroy, effect, computed,
} from '@angular/core';
import { DecimalPipe, NgClass } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { LucideTrash2 } from '@lucide/angular';
import { SseService, type MediaProgressSubject } from '../../../core/services/sse.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { PaginationComponent } from '../../../shared/components/pagination/pagination';
import { DropdownMenuComponent } from '../../../shared/components/dropdown-menu';
import { LocaleDatePipe } from '../../../core/pipes/locale-date.pipe';

interface CommandEntry { id: number; name: string; status: string; trigger: string; startedOn: string; endedOn?: string; body?: Record<string, unknown>; }
interface ServiceStatus { name: string; ok: boolean; message?: string; }
interface HealthReport { version: string; uptimeSeconds: number; database: ServiceStatus; installedPlugins: number; runningPlugins: number; restartSupervisor: string | null; }
/** Trimmed to what the manual-trigger button list needs. */
interface SchedulerJob { name: string; triggerable: boolean; labelKey: string; }
/** One row of the Activity table: running or queued work, from `ActivityRegistryService`. */
interface ActivityEntry {
  id: string;
  type: string;
  subject?: MediaProgressSubject;
  status: 'running' | 'pending';
  current?: number;
  total?: number;
}
/** A top-level row, its nested children (if any) travelling inline. */
interface ActivityRow extends ActivityEntry {
  children?: ActivityEntry[];
}
/** A parent's queued backlog can run into the hundreds during a big import,
 *  render only this many children and fold the rest into a "N more" line. */
const MAX_VISIBLE_CHILDREN = 5;

@Component({
  selector: 'app-system-status',
  imports: [TranslatePipe, LocaleDatePipe, DecimalPipe, NgClass, RouterLink, LucideTrash2, PaginationComponent, DropdownMenuComponent],
  templateUrl: './status.html',
})
export class SystemStatusComponent implements OnInit, OnDestroy {
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

  readonly registeredJobs = signal<SchedulerJob[]>([]);

  readonly activity = signal<ActivityRow[]>([]);
  readonly activityTotal = signal(0);
  readonly activityPage = signal(1);
  /** Cumulative count of registrations the backend's activity registry had to
   *  drop because it was at capacity (near-impossible in practice), surfaced
   *  rather than left as a silently missing row. */
  readonly activityDropped = signal(0);
  readonly maxVisibleChildren = MAX_VISIBLE_CHILDREN;
  /** Throttles the SSE-triggered refetch to roughly once a second: a library import
   *  can ping `activity.changed` many times a second, and a fetch per ping would just
   *  move the flood from the wire to the API. */
  private activityRefetchTimer: ReturnType<typeof setTimeout> | null = null;
  private activityRefetchPending = false;

  /** Core's own manual-trigger groups. A publisher's jobs never join one of
   *  these — they land in the dynamic group `commandItems` appends below. */
  readonly coreCommandGroups: (
    | { type: 'single'; name: string; label: string }
    | { type: 'group'; label: string; items: { name: string; label: string }[] }
  )[] = [
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

  private readonly coreCommandNames = new Set(
    this.coreCommandGroups.flatMap((g) => (g.type === 'single' ? [g.name] : g.items.map((i) => i.name))),
  );

  /** Core's groups, plus whatever a publisher registered that core doesn't already
   *  show — SearchMissing/RssSync/... with the acquisition bundle on, nothing without it. */
  readonly commandItems = computed(() => {
    const dynamic = this.registeredJobs()
      .filter((j) => j.triggerable && !this.coreCommandNames.has(j.name))
      .map((j) => ({ name: j.name, label: j.labelKey }));
    if (dynamic.length === 0) return this.coreCommandGroups;
    return [...this.coreCommandGroups, { type: 'group' as const, label: 'system.cmd_group_media', items: dynamic }];
  });

  /** Flat list for label lookups in command history. */
  readonly availableCommands = computed(() => [
    ...this.commandItems().flatMap(item =>
      item.type === 'single' ? [item] : item.items,
    ),
    // Non-triggerable commands (background-only) that still appear in history
    // and, for the per-file ones, in the live Activity table.
    { name: 'IntroDetection', label: 'system.cmd_intro_detection' },
    { name: 'GenerateSprite', label: 'system.cmd_generate_sprite' },
    { name: 'WarmupSubtitles', label: 'system.cmd_warmup_subtitles' },
    { name: 'PostImportEnrich', label: 'system.cmd_post_import_enrich' },
    { name: 'PostImportEnrichQueue', label: 'system.cmd_post_import_enrich_queue' },
    { name: 'OrphanImport', label: 'system.cmd_orphan_import' },
  ]);

  constructor() {
    effect(() => {
      const event = this.sse.lastEvent();
      if (event?.type === 'command.started' || event?.type === 'command.completed') {
        this.loadCommands(this.commandsPage());
      }
      if (event?.type === 'activity.changed') {
        this.scheduleActivityRefetch();
      }
    });
  }

  ngOnInit() {
    this.loadHealth();
    this.loadCommands();
    this.loadSchedulers();
    this.loadActivity();
  }

  ngOnDestroy() {
    if (this.activityRefetchTimer) clearTimeout(this.activityRefetchTimer);
  }

  /** Feeds the dynamic trigger-button group — silently empty on failure,
   *  same as any other publisher-fed part of this page. */
  async loadSchedulers() {
    try {
      this.registeredJobs.set(await firstValueFrom(this.http.get<SchedulerJob[]>('/api/commands/schedulers')));
    } catch {
      // handled by global interceptor
    }
  }

  async loadHealth() {
    this.healthLoading.set(true);
    try {
      this.health.set(await firstValueFrom(this.http.get<HealthReport>('/api/system/health')));
    } finally { this.healthLoading.set(false); }
  }

  /** Keeps the caller's page across an SSE-triggered refetch; falls back to page 1
   *  only when that page no longer exists (the queue drained under the viewer). */
  async loadActivity(page = this.activityPage()): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ data: ActivityRow[]; total: number; dropped: number }>('/api/system/activity', {
          params: { page: String(page), limit: '25' },
        }),
      );
      if (res.data.length === 0 && page > 1) {
        return this.loadActivity(1);
      }
      this.activityPage.set(page);
      this.activity.set(res.data);
      this.activityTotal.set(res.total);
      this.activityDropped.set(res.dropped);
    } catch {
      // handled by global interceptor
    }
  }

  /** Leading fetch, then at most one more per second while pings keep arriving. */
  private scheduleActivityRefetch() {
    if (this.activityRefetchTimer) {
      this.activityRefetchPending = true;
      return;
    }
    void this.loadActivity(this.activityPage());
    this.activityRefetchTimer = setTimeout(() => {
      this.activityRefetchTimer = null;
      if (this.activityRefetchPending) {
        this.activityRefetchPending = false;
        this.scheduleActivityRefetch();
      }
    }, 1000);
  }

  get activityTotalPages(): number {
    return Math.max(1, Math.ceil(this.activityTotal() / 25));
  }

  activityPercent(item: ActivityEntry): number {
    if (!item.total) return 0;
    return Math.min(100, Math.round(((item.current ?? 0) / item.total) * 100));
  }

  /** "S01E03 · Episode title" (or just "S01" for a whole-season task); empty when
   *  the subject carries no season at all (a movie, or plain media-level work). */
  episodeLine(subject: MediaProgressSubject): string {
    if (subject.seasonNumber == null) return '';
    const season = `S${String(subject.seasonNumber).padStart(2, '0')}`;
    const code = subject.episodeNumber != null
      ? `${season}E${String(subject.episodeNumber).padStart(2, '0')}`
      : season;
    return subject.episodeTitle ? `${code} · ${subject.episodeTitle}` : code;
  }

  /** `null` when the subject carries no media id: the title then renders as
   *  plain text instead of a link a producer can't actually resolve. */
  mediaRouterLink(subject: MediaProgressSubject): unknown[] | null {
    if (subject.mediaId == null) return null;
    return ['/' + (subject.mediaType === 'series' ? 'series' : 'movies'), subject.mediaId];
  }

  /** `null` when there's no episode id to link to (a season-level row, or a
   *  producer that didn't have one cheaply in hand). */
  episodeRouterLink(subject: MediaProgressSubject): unknown[] | null {
    if (subject.mediaId == null || subject.episodeId == null) return null;
    return ['/series', subject.mediaId, 'episode', subject.episodeId];
  }

  visibleChildren(item: ActivityRow): ActivityEntry[] {
    return item.children?.slice(0, MAX_VISIBLE_CHILDREN) ?? [];
  }

  hiddenChildrenCount(item: ActivityRow): number {
    return Math.max(0, (item.children?.length ?? 0) - MAX_VISIBLE_CHILDREN);
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
    return this.availableCommands().find((c) => c.name === baseName)?.label ?? commandName;
  }
}
