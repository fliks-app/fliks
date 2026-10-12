import { Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
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
import {
  LucideArrowRightLeft,
  LucideArrowUpDown,
  LucideAudioLines,
  LucideCaptions,
  LucideCast,
  LucideCircleStop,
  LucideCircleX,
  LucideRefreshCw,
  LucideRotateCcw,
  LucideTriangleAlert,
} from '@lucide/angular';
import { QOE_CAUSE_DOT_CLASS, QOE_CAUSE_TEXT_CLASS, codecLabel, durationParts, hintParams, loadLine, pipelineChain, pipelineParts, qualityLabel, rungDisplay, stallBreakdown, stallExplanation, translateFmt, type Fmt } from '../qoe-stall';
import { buildTimeline, isOngoing, type RungName, type Timeline, type TimelineBlock, type TimelineTransition } from '../qoe-timeline';
import { blockSummary, blockTitle, clockLabel, detailsOpen, formatPosition, ownStalls, timelineSteps, unreportedStalls } from '../qoe-timeline-view';
import { QOE_VERDICTS, QOE_VERDICT_BAR_CLASS, formatMbps, qoeDotClass } from '../qoe-health';
import { mergeDevices } from '../qoe-devices';

const PAGE_SIZE = 25;

/** A change as a title line and an optional "from → to" line. */
interface ChangeLines {
  title: string;
  detail?: string;
}

const TABS = ['sessions', 'devices', 'settings'] as const;
type Tab = (typeof TABS)[number];

@Component({
  selector: 'app-system-playback-quality',
  imports: [
    FormsModule,
    TranslatePipe,
    LocaleDatePipe,
    LucideArrowRightLeft,
    LucideArrowUpDown,
    LucideAudioLines,
    LucideCaptions,
    LucideCast,
    LucideCircleStop,
    LucideCircleX,
    LucideRefreshCw,
    LucideRotateCcw,
    LucideTriangleAlert,
    ModalFooterComponent,
    ModalHeaderComponent,
    PaginationComponent,
    SelectFieldComponent,
    ToggleFieldComponent,
  ],
  templateUrl: './playback-quality.html',
})
export class SystemPlaybackQualityComponent implements OnInit {
  private readonly api = inject(QoeApiService);
  private readonly settings = inject(SettingsApiService);
  private readonly users = inject(UsersApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly tabs = TABS;
  /** Kept in `?tab=` so a link opens the right tab. */
  readonly tab = signal<Tab>(this.tabFromUrl());

  readonly verdicts = QOE_VERDICTS;
  readonly barClass = QOE_VERDICT_BAR_CLASS;
  readonly causeDot = QOE_CAUSE_DOT_CLASS;
  readonly causeText = QOE_CAUSE_TEXT_CLASS;
  readonly detailsOpen = detailsOpen;

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
  /** Devices as the admin names them: every browser version of "Chrome on Linux" is one device. */
  readonly devices = computed(() => mergeDevices(this.summary()?.byDevice ?? [], (d) => this.formatDevice(d.device, d.systemName)));
  /** Label → the raw device labels it covers, for the session filter. */
  readonly deviceOptions = computed(() => {
    const map = new Map<string, string[]>();
    for (const d of this.devices()) map.set(d.label, [...(map.get(d.label) ?? []), ...d.raw]);
    return [...map].map(([label, raw]) => ({ label, raw }));
  });
  readonly detail = signal<QoeSessionDetail | null>(null);
  private readonly detailDialog = viewChild<ElementRef<HTMLDialogElement>>('detailDialog');

  readonly timeline = computed(() => {
    const d = this.detail();
    return d ? buildTimeline(d.sessions, d.events) : null;
  });
  readonly steps = computed(() => {
    const tl = this.timeline();
    const d = this.detail();
    return tl && d ? timelineSteps(tl, this.endMs(d)) : [];
  });
  readonly stallCauses = computed(() => stallBreakdown(this.detail()?.events ?? []));

  readonly qoeEnabled = signal(true);
  readonly retentionDays = signal(30);
  readonly savingSettings = signal(false);

  readonly verdictTotal = computed(() => {
    const by = this.summary()?.byVerdict;
    return by ? this.verdicts.reduce((n, v) => n + (by[v] ?? 0), 0) : 0;
  });

  private tabFromUrl(): Tab {
    const t = this.route.snapshot.queryParamMap.get('tab');
    return TABS.includes(t as Tab) ? (t as Tab) : 'sessions';
  }

  setTab(t: Tab) {
    this.tab.set(t);
    void this.router.navigate([], { relativeTo: this.route, queryParams: { tab: t }, queryParamsHandling: 'merge', replaceUrl: true });
  }

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
        devices: this.deviceOptions().find((o) => o.label === this.deviceFilter())?.raw,
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

  readonly fmt: Fmt = translateFmt(this.translate);

  duration(ms: number | null | undefined): string {
    if (ms == null) return '-';
    const d = durationParts(ms);
    return this.translate.instant(d.key, d.params);
  }

  seconds(ms: number): string {
    return this.translate.instant('qoe.seconds', { value: this.fmt.n(ms / 1000, 1) });
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

  /** "Image figée pendant 9,6 s, à 3:17 de la vidéo". */
  frozenTitle(e: QoeEventRow): string {
    const duration = this.seconds(e.data?.durationMs ?? 0);
    const pos = e.data?.position;
    return pos == null
      ? this.translate.instant('qoe.block.frozen', { duration })
      : this.translate.instant('qoe.block.frozen_pos', { duration, pos: formatPosition(pos) });
  }

  /** "Cause : réseau. Le débit (2,0 Mbps) ne suivait pas…", "probable" when the evidence is thin. */
  causeSentence(e: QoeEventRow): string {
    const d = e.data;
    if (!d?.cause || d.cause === 'unknown') return this.translate.instant('qoe.block.cause_unknown');
    const x = stallExplanation(e, this.fmt.n);
    const explanation = x ? this.translate.instant(x.key, x.params) : '';
    return this.translate
      .instant(d.causeConfidence === 'low' ? 'qoe.block.cause_probable' : 'qoe.block.cause_sure', {
        cause: this.translate.instant(`qoe.cause_word.${d.cause}`),
        explanation,
      })
      .trim();
  }

  causeTextClass(e: QoeEventRow): string {
    return QOE_CAUSE_TEXT_CLASS[e.data?.cause ?? 'unknown'];
  }

  errorTitle(e: QoeEventRow): string {
    const message = e.data?.message;
    return message ? this.translate.instant('qoe.block.error', { message }) : this.translate.instant('qoe.block.error_plain');
  }

  errorDetail(e: QoeEventRow): string {
    return [e.data?.category, e.data?.code].filter((x) => x != null && x !== '').join(' · ');
  }

  /** An event that did not open a new session: an adaptive quality change, a reload, a recovery. */
  otherEventLines(e: QoeEventRow): ChangeLines {
    const d = e.data ?? {};
    if (e.type === 'quality_switch') {
      return this.change('qoe.transition.quality_switch', formatMbps(d.fromBitrate, this.fmt), formatMbps(d.toBitrate, this.fmt));
    }
    if (e.type === 'reload') return this.reloadLines(d);
    return { title: this.translate.instant('qoe.transition.recovery') };
  }

  unreportedText(b: TimelineBlock, incoming: TimelineTransition | null = null): string {
    const u = unreportedStalls(b, incoming);
    if (!u) return '';
    const duration = this.seconds(u.ms);
    return u.count === 1
      ? this.translate.instant('qoe.block.unreported_one', { duration })
      : this.translate.instant('qoe.block.unreported_many', { count: String(u.count), duration });
  }

  /** Rows of the always-visible summary; a value unknown by design for this engine is left out. */
  summaryRows(d: QoeSessionDetail): { label: string; hint?: string; value: string }[] {
    const rows: { label: string; hint?: string; value: string }[] = [];
    const add = (label: string, value: string | null | undefined, hint?: string) => {
      if (value) rows.push({ label: this.translate.instant(label), hint: hint ? this.translate.instant(hint) : undefined, value });
    };
    add('qoe.watched', d.watchedMs == null ? null : this.duration(d.watchedMs), 'qoe.watched_hint');
    add('qoe.summary.device', this.deviceText(d));
    add('qoe.engine', d.engine, 'qoe.hint.engine');
    const res = d.width && d.height ? `${d.width}×${d.height}` : '';
    add('qoe.summary.quality', [this.qualityText(d) === '-' ? '' : this.qualityText(d), res].filter(Boolean).join(' · '), 'qoe.hint.quality');
    add('qoe.summary.codec', codecLabel(d.videoCodec));
    add('qoe.throughput_measured', formatMbps(d.avgBandwidthBps, this.fmt), 'qoe.hint.throughput_measured');
    add('qoe.bitrate_video', formatMbps(d.avgVariantBitrate, this.fmt), 'qoe.hint.bitrate_video');
    add('qoe.dropped', d.droppedPct == null ? null : `${this.fmt.n(d.droppedPct, 1)} %`, 'qoe.hint.dropped');
    if (d.decoderName != null || d.hwDecoder != null) {
      const kind = d.hwDecoder == null ? '' : this.translate.instant(d.hwDecoder ? 'qoe.hardware' : 'qoe.software');
      add('qoe.decoder', [d.decoderName, kind && `(${kind})`].filter(Boolean).join(' '), 'qoe.hint.decoder');
    }
    if (d.cmcd != null) add('CMCD', this.translate.instant(d.cmcd ? 'common.yes' : 'common.no'), 'qoe.hint.cmcd');
    add('qoe.summary.sessions', String(d.sessions.length), 'qoe.hint.session');
    return rows;
  }

  qualityText(row: QoeSessionRow): string {
    return qualityLabel(row, this.fmt);
  }

  private startMs(d: QoeSessionDetail): number {
    return new Date(d.startedAt).getTime();
  }

  /** HH:MM:SS, with the date only when the playback crosses midnight. */
  clock(ms: number | string, d: QoeSessionDetail): string {
    return clockLabel(typeof ms === 'number' ? ms : Date.parse(ms), this.startMs(d), this.lang);
  }

  /** "Playback of 13/10/2026 · 00:01:28 → 00:02:56 · 1 min 28 s". */
  timelineHeader(d: QoeSessionDetail): string {
    const start = this.startMs(d);
    const end = isOngoing(d) ? null : new Date(d.endedAt ?? d.lastSeenAt).getTime();
    return this.translate.instant('qoe.timeline_header', {
      date: new Date(start).toLocaleDateString(this.lang, { dateStyle: 'short' }),
      from: this.clock(start, d),
      to: end == null ? this.translate.instant('qoe.summary.ongoing') : this.clock(end, d),
      duration: end == null ? '-' : this.duration(end - start),
    });
  }

  endMs(d: QoeSessionDetail): number | null {
    return isOngoing(d) ? null : new Date(d.endedAt ?? d.lastSeenAt).getTime();
  }

  blockTitle(b: TimelineBlock): string {
    return blockTitle(b.session, b.first, this.fmt);
  }

  /** "2 min 09 s · aucune coupure", led by the quality when a change opened the session (the change is the title). */
  blockSummary(b: TimelineBlock, incoming: TimelineTransition | null = null, spanMs: number | null = null): string {
    // A session shorter than a heartbeat never measured its playback time: its span on the timeline says it.
    const watchedMs = b.session.watchedMs || spanMs;
    const summary = blockSummary({ watchedMs, ...ownStalls(b, incoming) }, this.fmt);
    if (!incoming || incoming.kind === 'handoff') return summary;
    const quality = this.qualityText(b.session);
    return quality && quality !== '-' ? `${quality} · ${summary}` : summary;
  }

  /** The technical figures of one session, folded under "Technical details". */
  detailRows(s: QoeSessionRow): { label: string; value: string }[] {
    const rows: { label: string; value: string }[] = [];
    const add = (label: string, value: string | null | undefined) => {
      if (value) rows.push({ label: this.translate.instant(label), value });
    };
    add('qoe.pipeline.title', this.pipelineText(s.pipeline, s));
    add('qoe.summary.codec', codecLabel(s.videoCodec));
    if (s.decoderName != null || s.hwDecoder != null) {
      const kind = s.hwDecoder == null ? '' : this.translate.instant(s.hwDecoder ? 'qoe.hardware' : 'qoe.software');
      add('qoe.decoder', [s.decoderName, kind && `(${kind})`].filter(Boolean).join(' '));
    }
    add('qoe.throughput_measured', formatMbps(s.avgBandwidthBps, this.fmt));
    add('qoe.bitrate_video', formatMbps(s.avgVariantBitrate, this.fmt));
    add('qoe.dropped', s.droppedPct == null ? null : `${this.fmt.n(s.droppedPct, 1)} %`);
    return rows;
  }

  private rungLabel(r: RungName | null, bitrate: number | null, from: boolean): string {
    const auto = this.translate.instant('qoe.pipeline.auto');
    const name = !r ? '' : from && r.auto ? auto : r.rung ? rungDisplay(r.rung, this.fmt) : r.auto ? auto : '';
    const rate = bitrate == null ? '' : this.translate.instant('qoe.mbps', { value: this.fmt.n(bitrate / 1_000_000, 1) });
    return rate ? (name ? `${name} (${rate})` : rate) : name;
  }

  /** The marker of a change: what changed, not just that something did. */
  changeIcon(type: string, reason?: string, cast = false): 'quality' | 'recovery' | 'audio' | 'subtitles' | 'reload' | 'cast' | 'other' {
    if (cast) return 'cast';
    if (type === 'quality_switch') return 'quality';
    if (type === 'recovery') return 'recovery';
    if (type === 'reload') return reason === 'audio' ? 'audio' : reason === 'subtitles' ? 'subtitles' : 'reload';
    return 'other';
  }

  transitionIcon(t: TimelineTransition) {
    return this.changeIcon(t.event?.type ?? t.kind, t.event?.data?.reason, t.kind === 'handoff');
  }

  /** What happened between two session blocks: a title, then what it changed from and to. */
  transitionLines(t: TimelineTransition): ChangeLines {
    if (t.kind === 'quality_switch') {
      return this.change('qoe.transition.quality_switch', this.rungLabel(t.from, t.fromBitrate, true), this.rungLabel(t.to, t.toBitrate, false));
    }
    if (t.kind === 'reload') return this.reloadLines(t.event?.data ?? null);
    if (t.kind === 'recovery' && t.event) return this.recoveryLines(t.event);
    return { title: this.translate.instant(`qoe.transition.${t.kind}`) };
  }

  /** "Reprise après 9 s", then why the player had to re-mint its session. */
  private recoveryLines(e: QoeEventRow): ChangeLines {
    const ms = e.data?.durationMs ?? 0;
    const title =
      ms > 0
        ? this.translate.instant('qoe.transition.recovery_after', { duration: this.seconds(ms) })
        : this.translate.instant('qoe.transition.recovery');
    return { title, detail: e.data?.cause ? this.causeSentence(e) : undefined };
  }

  private change(titleKey: string, from: string, to: string): ChangeLines {
    return { title: this.translate.instant(titleKey), detail: `${from || '-'} → ${to || '-'}` };
  }

  private reloadLines(d: QoeEventRow['data']): ChangeLines {
    const lang = (code?: string) => {
      try {
        return (code && new Intl.DisplayNames(this.lang, { type: 'language' }).of(code)) || code || '-';
      } catch {
        return code || '-';
      }
    };
    const title = (key: string, params?: Record<string, string>) => ({ title: this.translate.instant(key, params) });
    switch (d?.reason) {
      case 'audio':
        return this.change('qoe.transition.reload_audio', d.from ?? '', d.to ?? '');
      case 'subtitles':
        if (d.from === 'hls') return title('qoe.transition.reload_subtitles_hls', { lang: lang(d.to) });
        return d.to ? title('qoe.transition.reload_subtitles_on', { lang: lang(d.to) }) : title('qoe.transition.reload_subtitles_off');
      case 'remux_fallback':
        return title('qoe.transition.reload_remux_fallback');
      default:
        return title('qoe.transition.reload_other');
    }
  }

  reasonText(key: string): string {
    return this.translate.instant(key);
  }
}
