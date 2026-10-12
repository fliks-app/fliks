import { Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  QOE_SETTING_ENABLED,
  QOE_SETTING_RETENTION_DAYS,
  QoeApiService,
  QoeEventRow,
  QoePipeline,
  QoeSessionDetail,
  QoeSessionRow,
  QoeSummary,
  QoeVerdict,
} from '../../../core/services/api/qoe-api.service';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { UserRow, UsersApiService } from '../../../core/services/api/users-api.service';
import { ToastService } from '../../../core/services/toast.service';
import { LocaleDatePipe } from '../../../core/pipes/locale-date.pipe';
import { SelectFieldComponent } from '../../../shared/components/forms/select-field/select-field';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';
import { ModalFooterComponent } from '../../../shared/components/modal-footer';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { PaginationComponent } from '../../../shared/components/pagination/pagination';
import { parseDeviceLabel } from '../../../core/utils/format-device-label';
import { QOE_CAUSE_DOT_CLASS, codecLabel, durationParts, eventStartMs, hintParams, loadLine, pipelineChain, pipelineParts, qualityLabel, stallBreakdown, stallExplanation, type Fmt } from '../qoe-stall';
import { QOE_VERDICTS, QOE_VERDICT_BAR_CLASS, formatMbps, qoeDotClass } from '../qoe-health';

const PAGE_SIZE = 25;

@Component({
  selector: 'app-system-playback-quality',
  imports: [FormsModule, TranslatePipe, LocaleDatePipe, ModalFooterComponent, ModalHeaderComponent, PaginationComponent, SelectFieldComponent, ToggleFieldComponent],
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
  readonly causeDot = QOE_CAUSE_DOT_CLASS;

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
  // byDevice has one row per (device, engine), so the same device can repeat.
  readonly deviceOptions = computed(() => [
    ...new Set((this.summary()?.byDevice ?? []).map((d) => d.device).filter((d): d is string => !!d)),
  ]);
  readonly detail = signal<QoeSessionDetail | null>(null);
  private readonly detailDialog = viewChild<ElementRef<HTMLDialogElement>>('detailDialog');

  readonly stallCauses = computed(() => stallBreakdown(this.detail()?.events ?? []));

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

  setUserFilter(id: string) {
    this.userFilter.set(id ? Number(id) : null);
    this.applyFilters();
  }

  applyFilters() {
    void this.loadSessions(1);
  }

  async openDetail(row: QoeSessionRow) {
    try {
      this.detail.set(await this.api.session(row.sessionId));
      this.detailDialog()?.nativeElement.showModal();
    } catch {
      /* interceptor */
    }
  }

  closeDetail() {
    this.detailDialog()?.nativeElement.close();
  }

  exportJson(d: QoeSessionDetail) {
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `playback-quality-${d.playbackId ?? d.sessionId}.json`;
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
    return qoeDotClass(row);
  }

  private get lang(): string {
    return this.translate.currentLang() || this.translate.fallbackLang() || 'en';
  }

  /** Translation and locale number formatting for the helpers in qoe-stall.ts. */
  readonly fmt: Fmt = {
    t: (key, params) => this.translate.instant(key, params),
    n: (v, digits = 1) => v.toLocaleString(this.lang, { minimumFractionDigits: digits, maximumFractionDigits: digits }),
  };

  duration(ms: number | null | undefined): string {
    if (ms == null) return '-';
    const d = durationParts(ms);
    return this.translate.instant(d.key, d.params);
  }

  seconds(ms: number): string {
    return this.translate.instant('qoe.seconds', { value: this.fmt.n(ms / 1000, 1) });
  }

  eventStart(e: QoeEventRow): number {
    return eventStartMs(e);
  }

  /** "4K HEVC HDR10 → 1080p H.264 8.0 Mbps · tonemap OpenCL · decode QSV ...". */
  pipelineText(p: QoePipeline | null | undefined, row?: { width: number | null; height: number | null }): string {
    if (!p) return '';
    return [pipelineChain(p, this.fmt, p.output ? row : null), ...pipelineParts(p).map((x) => this.translate.instant(x.key, x.params))]
      .filter(Boolean)
      .join(' · ');
  }

  /** The pipeline of the session a stall belongs to. */
  stallPipeline(d: QoeSessionDetail, e: QoeEventRow): string {
    const s = d.sessions.find((x) => x.sessionId === e.sessionId);
    return this.pipelineText(s?.pipeline, s);
  }

  stallLoad(e: QoeEventRow): string {
    const l = e.data?.serverLoad;
    if (!l) return '';
    const x = loadLine(l, this.fmt.n);
    return this.translate.instant(x.key, x.params);
  }

  stallHints(e: QoeEventRow): string {
    const hints = e.data?.causeHints ?? [];
    if (!hints.length) return '';
    const p = hintParams(e);
    const list = hints.map((h) => this.translate.instant(h, p)).join(', ');
    return this.translate.instant('qoe.pipeline.hints', { list });
  }

  stallLine(e: QoeEventRow): string | null {
    const x = stallExplanation(e, this.fmt.n);
    return x ? this.translate.instant(x.key, x.params) : null;
  }

  /** One sentence per event, so a line reads without its column headers. */
  eventLine(e: QoeEventRow): string {
    const d = e.data ?? {};
    switch (e.type) {
      case 'stall':
        return this.translate.instant('qoe.line.stall', { duration: this.seconds(d.durationMs ?? 0) });
      case 'error': {
        const detail = [d.category, d.code, d.message].filter((x) => x != null && x !== '').join(' · ');
        return this.translate.instant(detail ? 'qoe.line.error' : 'qoe.line.error_plain', { detail });
      }
      case 'quality_switch':
        return this.translate.instant('qoe.line.quality_switch', {
          from: d.fromBitrate == null ? '-' : this.fmt.n(d.fromBitrate / 1_000_000, 1),
          to: d.toBitrate == null ? '-' : this.fmt.n(d.toBitrate / 1_000_000, 1),
        });
      default:
        return this.translate.instant('qoe.line.recovery');
    }
  }

  /** Rows of the always-visible summary; a value unknown by design for this engine is left out. */
  summaryRows(d: QoeSessionDetail): { label: string; hint?: string; value: string }[] {
    const rows: { label: string; hint?: string; value: string }[] = [];
    const add = (label: string, value: string | null | undefined, hint?: string) => {
      if (value) rows.push({ label: this.translate.instant(label), hint: hint ? this.translate.instant(hint) : undefined, value });
    };
    const when = (iso: string) => new Date(iso).toLocaleString(this.lang, { dateStyle: 'short', timeStyle: 'medium' });
    const ongoing = d.endedAt == null && Date.now() - new Date(d.lastSeenAt).getTime() < 120_000;
    add('qoe.summary.period', `${when(d.startedAt)} → ${ongoing ? this.translate.instant('qoe.summary.ongoing') : when(d.endedAt ?? d.lastSeenAt)}`);
    add('qoe.watched', d.watchedMs == null ? null : this.duration(d.watchedMs), 'qoe.watched_hint');
    add('qoe.summary.device', this.deviceText(d));
    add('qoe.engine', d.engine, 'qoe.hint.engine');
    const res = d.width && d.height ? `${d.width}×${d.height}` : '';
    add('qoe.summary.quality', [this.qualityText(d) === '-' ? '' : this.qualityText(d), res].filter(Boolean).join(' · '), 'qoe.hint.quality');
    add('qoe.summary.codec', codecLabel(d.videoCodec));
    if (d.avgBandwidthBps != null || d.avgVariantBitrate != null) {
      add('qoe.throughput', `${formatMbps(d.avgBandwidthBps)} / ${formatMbps(d.avgVariantBitrate)}`, 'qoe.hint.throughput');
    }
    add('qoe.dropped', d.droppedPct == null ? null : `${this.fmt.n(d.droppedPct, 1)} %`, 'qoe.hint.dropped');
    if (d.decoderName != null || d.hwDecoder != null) {
      const kind = d.hwDecoder == null ? '' : this.translate.instant(d.hwDecoder ? 'qoe.hardware' : 'qoe.software');
      add('qoe.decoder', [d.decoderName, kind && `(${kind})`].filter(Boolean).join(' '), 'qoe.hint.decoder');
    }
    if (d.cmcd != null) add('CMCD', this.translate.instant(d.cmcd ? 'common.yes' : 'common.no'), 'qoe.hint.cmcd');
    const last = d.sessions.at(-1);
    const pipe = this.pipelineText(last?.pipeline, last);
    add('qoe.pipeline.title', pipe, 'qoe.hint.pipeline');
    add('qoe.summary.sessions', String(d.sessions.length), 'qoe.hint.session');
    return rows;
  }

  qualityText(row: QoeSessionRow): string {
    return qualityLabel(row, this.fmt);
  }

  reasonText(key: string): string {
    return this.translate.instant(key);
  }

  formatPosition(s: number | null): string {
    if (s == null || !isFinite(s)) return '-';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }
}
