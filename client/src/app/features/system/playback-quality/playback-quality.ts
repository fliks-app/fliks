import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  QOE_SETTING_ENABLED,
  QOE_SETTING_RETENTION_DAYS,
  QoeApiService,
  QoeEventRow,
  QoeSessionDetail,
  QoeSessionRow,
  QoeSummary,
  QoeVerdict,
} from '../../../core/services/api/qoe-api.service';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { UserRow, UsersApiService } from '../../../core/services/api/users-api.service';
import { ToastService } from '../../../core/services/toast.service';
import { LocaleDatePipe } from '../../../core/pipes/locale-date.pipe';
import { PaginationComponent } from '../../../shared/components/pagination/pagination';
import { parseDeviceLabel } from '../../../core/utils/format-device-label';
import { QoeBadgeComponent } from '../qoe-badge/qoe-badge';
import { QOE_DOT_CLASS, QOE_VERDICTS, QOE_VERDICT_BAR_CLASS, formatMbps, qoeHealth } from '../qoe-health';

const PAGE_SIZE = 25;

@Component({
  selector: 'app-system-playback-quality',
  imports: [FormsModule, TranslatePipe, LocaleDatePipe, PaginationComponent, QoeBadgeComponent],
  templateUrl: './playback-quality.html',
})
export class SystemPlaybackQualityComponent implements OnInit {
  private readonly api = inject(QoeApiService);
  private readonly settings = inject(SettingsApiService);
  private readonly users = inject(UsersApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly verdicts = QOE_VERDICTS;
  readonly barClass = QOE_VERDICT_BAR_CLASS;
  readonly mbps = formatMbps;

  readonly days = signal(7);
  readonly summary = signal<QoeSummary | null>(null);
  readonly loading = signal(true);

  readonly verdictFilter = signal<QoeVerdict | ''>('');
  readonly userFilter = signal<number | null>(null);
  readonly deviceFilter = signal('');
  readonly page = signal(1);
  readonly sessions = signal<QoeSessionRow[]>([]);
  readonly total = signal(0);
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / PAGE_SIZE)));
  readonly userOptions = signal<UserRow[]>([]);

  readonly userNames = computed(() => new Map(this.userOptions().map((u) => [u.id, u.username])));
  readonly deviceOptions = computed(() =>
    (this.summary()?.byDevice ?? []).map((d) => d.device).filter((d): d is string => !!d),
  );
  readonly detail = signal<QoeSessionDetail | null>(null);

  readonly qoeEnabled = signal(true);
  readonly retentionDays = signal(30);
  readonly savingSettings = signal(false);

  readonly verdictTotal = computed(() => {
    const by = this.summary()?.byVerdict;
    return by ? this.verdicts.reduce((n, v) => n + (by[v] ?? 0), 0) : 0;
  });

  async ngOnInit() {
    void this.loadSettings();
    void this.users.list().then((u) => this.userOptions.set(u)).catch(() => {});
    await Promise.all([this.loadSummary(), this.loadSessions()]);
    this.loading.set(false);
  }

  private async loadSettings() {
    try {
      const map = await this.settings.getAll();
      this.qoeEnabled.set((map[QOE_SETTING_ENABLED] ?? 'true') === 'true');
      this.retentionDays.set(Number(map[QOE_SETTING_RETENTION_DAYS]) || 30);
    } catch {
      /* interceptor */
    }
  }

  async saveSettings() {
    this.savingSettings.set(true);
    try {
      await this.settings.set(QOE_SETTING_ENABLED, String(this.qoeEnabled()));
      await this.settings.set(
        QOE_SETTING_RETENTION_DAYS,
        String(Math.max(1, Math.floor(this.retentionDays() || 30))),
      );
      this.toast.success(this.translate.instant('qoe.settings_saved'));
    } catch {
      /* interceptor */
    } finally {
      this.savingSettings.set(false);
    }
  }

  setDays(days: number) {
    this.days.set(days);
    this.page.set(1);
    void this.loadSummary();
    void this.loadSessions();
  }

  async loadSummary() {
    try {
      this.summary.set(await this.api.summary(this.days()));
    } catch {
      this.summary.set(null);
    }
  }

  async loadSessions(page = this.page()) {
    this.page.set(page);
    try {
      const res = await this.api.sessions({
        days: this.days(),
        verdict: this.verdictFilter(),
        userId: this.userFilter(),
        device: this.deviceFilter().trim() || undefined,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      this.sessions.set(res.items);
      this.total.set(res.total);
    } catch {
      this.sessions.set([]);
      this.total.set(0);
    }
  }

  applyFilters() {
    void this.loadSessions(1);
  }

  async openDetail(row: QoeSessionRow) {
    try {
      this.detail.set(await this.api.session(row.sessionId));
    } catch {
      /* interceptor */
    }
  }

  closeDetail() {
    this.detail.set(null);
  }

  exportJson(d: QoeSessionDetail) {
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `playback-quality-${d.sessionId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  userName(id: number | null): string {
    return id == null ? '-' : (this.userNames().get(id) ?? `#${id}`);
  }

  /** `deviceLabel` is the raw user agent for web and desktop clients. */
  formatDevice(raw: string | null, systemName: string | null = null): string {
    if (!raw) return '-';
    const label = parseDeviceLabel(raw, systemName);
    return label ? this.translate.instant(label.key, label.params) : raw;
  }

  deviceText(r: QoeSessionRow): string {
    return [this.formatDevice(r.deviceLabel, r.systemName), r.appVersion].filter((x) => x && x !== '-').join(' · ') || '-';
  }

  barWidth(v: QoeVerdict): number {
    const total = this.verdictTotal();
    return total ? ((this.summary()?.byVerdict[v] ?? 0) / total) * 100 : 0;
  }

  pct(part: number, whole: number): string {
    return whole ? `${Math.round((part / whole) * 100)} %` : '-';
  }

  pctValue(v: number | null | undefined): string {
    return v == null ? '-' : `${Math.round(v)} %`;
  }

  dotClass(row: QoeSessionRow): string {
    return QOE_DOT_CLASS[qoeHealth(row)];
  }

  eventLabel(e: QoeEventRow): string {
    return this.translate.instant(`qoe.event.${e.type}`);
  }

  eventDetail(e: QoeEventRow): string {
    const d = e.data ?? {};
    switch (e.type) {
      case 'stall':
        return `${((d.durationMs ?? 0) / 1000).toFixed(1)} s`;
      case 'error':
        return [d.category, d.code, d.message].filter((x) => x != null && x !== '').join(' · ');
      case 'quality_switch':
        return `${formatMbps(d.fromBitrate)} → ${formatMbps(d.toBitrate)}`;
      default:
        return '';
    }
  }

  formatPosition(s: number | null): string {
    if (s == null || !isFinite(s)) return '-';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }
}
