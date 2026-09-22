import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
  effect,
  viewChild,
  ElementRef,
} from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import {
  LiveTvApiService,
  LiveChannel,
  LiveProgram,
} from '../../../core/services/api/livetv-api.service';
import { LocaleDatePipe } from '../../../core/pipes/locale-date.pipe';
import { TvSectionDirective } from '../../../shared/directives/tv-section.directive';
import { TvRowDirective } from '../../../shared/directives/tv-row.directive';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { LucideChevronLeft, LucideChevronRight, LucidePlay } from '@lucide/angular';
import { TvSelectDirective } from '../../../shared/directives/tv-select.directive';

/** Visible span of the grid, in hours. */
const TIMELINE_HOURS = 4;
/** Extra hours fetched on each side of the visible span: the "one screen of margin" budget. */
const MARGIN_HOURS = TIMELINE_HOURS / 2;
const PX_PER_MINUTE = 4;
const CHANNEL_PAGE_SIZE = 50;
/** Rows near the bottom that trigger the next channel page. */
const LOAD_MORE_THRESHOLD_PX = 400;

interface PositionedProgram extends LiveProgram {
  left: string;
  width: string;
}

interface GuideRow {
  channel: LiveChannel;
  programs: PositionedProgram[];
}

interface DisplayRow extends GuideRow {
  nowProgram: PositionedProgram | null;
  nextProgram: PositionedProgram | null;
}

@Component({
  selector: 'app-live-tv-guide',
  imports: [TvSelectDirective, 
    FormsModule,
    TranslatePipe,
    LocaleDatePipe,
    TvSectionDirective,
    TvRowDirective,
    ModalHeaderComponent,
    LucideChevronLeft,
    LucideChevronRight,
    LucidePlay,
  ],
  templateUrl: './guide.html',
})
export class LiveTvGuideComponent implements OnInit, OnDestroy {
  private readonly api = inject(LiveTvApiService);
  private readonly router = inject(Router);

  private readonly scrollEl = viewChild<ElementRef<HTMLElement>>('scrollArea');
  private readonly sheetDialog = viewChild<ElementRef<HTMLDialogElement>>('sheetDialog');

  readonly windowStart = signal(this.roundToHalfHour(new Date()));
  readonly rows = signal<GuideRow[]>([]);
  readonly loading = signal(true);
  readonly loadingMore = signal(false);
  readonly loadError = signal(false);
  readonly total = signal(0);
  readonly groups = signal<string[]>([]);
  readonly groupFilter = signal('');
  readonly favoritesOnly = signal(false);

  /** Ticks every minute so the now line and the mobile now/next markers stay live without a reload. */
  private readonly clock = signal(Date.now());

  readonly hasMore = computed(() => this.rows().length < this.total());

  readonly fetchFrom = computed(() => new Date(this.windowStart().getTime() - MARGIN_HOURS * 3_600_000));
  readonly fetchTo = computed(
    () => new Date(this.windowStart().getTime() + (TIMELINE_HOURS + MARGIN_HOURS) * 3_600_000),
  );
  readonly totalMinutes = computed(() => (this.fetchTo().getTime() - this.fetchFrom().getTime()) / 60_000);
  readonly timelineWidthPx = computed(() => this.totalMinutes() * PX_PER_MINUTE);
  readonly hourMarks = computed(() => {
    const marks: Date[] = [];
    const start = this.fetchFrom();
    for (let m = 0; m <= this.totalMinutes(); m += 60) marks.push(new Date(start.getTime() + m * 60_000));
    return marks;
  });

  readonly nowOffsetPx = computed(
    () => this.minutesFromStart(new Date(this.clock())) * PX_PER_MINUTE,
  );
  readonly showNowLine = computed(() => {
    const now = this.clock();
    return now >= this.fetchFrom().getTime() && now <= this.fetchTo().getTime();
  });

  /** now/next per row, re-derived from the clock so a finished program doesn't stay "now" until the next fetch. */
  readonly displayRows = computed<DisplayRow[]>(() => {
    const now = this.clock();
    return this.rows().map((row) => ({
      ...row,
      nowProgram:
        row.programs.find(
          (p) => new Date(p.startsAt).getTime() <= now && now < new Date(p.endsAt).getTime(),
        ) ?? null,
      nextProgram:
        row.programs
          .filter((p) => new Date(p.startsAt).getTime() > now)
          .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())[0] ??
        null,
    }));
  });

  readonly selectedSheet = signal<{ channel: LiveChannel; program: LiveProgram } | null>(null);

  private page = 1;
  private loadSeq = 0;
  private clockTimer?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    void this.loadGroups();
    void this.loadWindow(true);
    this.clockTimer = setInterval(() => this.clock.set(Date.now()), 60_000);
  }

  ngOnDestroy(): void {
    clearInterval(this.clockTimer);
  }

  /** Recenters the horizontal scroll on the visible window after a jump or the first load. */
  private readonly recenterEffect = effect(() => {
    this.windowStart();
    const el = this.scrollEl()?.nativeElement;
    if (el) el.scrollLeft = MARGIN_HOURS * 60 * PX_PER_MINUTE;
  });

  private roundToHalfHour(d: Date): Date {
    const rounded = new Date(d);
    rounded.setMinutes(rounded.getMinutes() < 30 ? 0 : 30, 0, 0);
    return rounded;
  }

  private async loadGroups(): Promise<void> {
    try {
      const channels = await this.api.getChannels();
      const set = new Set<string>();
      for (const c of channels) if (c.groupName) set.add(c.groupName);
      this.groups.set([...set].sort());
    } catch {
      // filter dropdown stays empty; not fatal
    }
  }

  async loadWindow(reset: boolean): Promise<void> {
    if (reset) {
      this.page = 1;
      this.rows.set([]);
      this.total.set(0);
      this.loadingMore.set(false); // a reset supersedes any pagination fetch in flight
    } else if (!this.hasMore() || this.loadingMore()) {
      return;
    }
    const seq = ++this.loadSeq;
    const requestedPage = reset ? 1 : this.page + 1;
    (reset ? this.loading : this.loadingMore).set(true);
    try {
      const res = await this.api.getGuide({
        from: this.fetchFrom().toISOString(),
        to: this.fetchTo().toISOString(),
        group: this.groupFilter() || undefined,
        favoritesOnly: this.favoritesOnly() || undefined,
        page: requestedPage,
        pageSize: CHANNEL_PAGE_SIZE,
      });
      if (seq !== this.loadSeq) return;
      if (!reset) this.page = requestedPage;
      const newRows: GuideRow[] = (res.channels ?? []).map((channel) =>
        this.buildRow(
          channel,
          (channel.guideChannelId && res.programs?.[channel.guideChannelId]) || [],
        ),
      );
      this.rows.update((r) => (reset ? newRows : [...r, ...newRows]));
      this.total.set(res.total ?? 0);
      this.loadError.set(false);
    } catch {
      if (seq === this.loadSeq) this.loadError.set(true);
    } finally {
      if (seq === this.loadSeq) (reset ? this.loading : this.loadingMore).set(false);
    }
  }

  onScroll(event: Event): void {
    const el = event.target as HTMLElement;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_MORE_THRESHOLD_PX) {
      void this.loadWindow(false);
    }
  }

  onFilterChange(): void {
    void this.loadWindow(true);
  }

  jumpWindow(hours: number): void {
    this.windowStart.update((d) => new Date(d.getTime() + hours * 3_600_000));
    void this.loadWindow(true);
  }

  jumpToNow(): void {
    this.windowStart.set(this.roundToHalfHour(new Date()));
    this.clock.set(Date.now());
    void this.loadWindow(true);
  }

  get dayPickerValue(): string {
    const d = this.windowStart();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  onDayPicked(value: string): void {
    if (!value) return;
    const [y, m, d] = value.split('-').map(Number);
    const current = this.windowStart();
    this.windowStart.set(new Date(y, m - 1, d, current.getHours(), current.getMinutes()));
    void this.loadWindow(true);
  }

  private minutesFromStart(d: Date): number {
    return (d.getTime() - this.fetchFrom().getTime()) / 60_000;
  }

  /** Positions programs once per fetch; left/width are absolute against `fetchFrom` so a later clock tick can't move them. */
  private buildRow(channel: LiveChannel, programs: LiveProgram[]): GuideRow {
    const totalMinutes = this.totalMinutes();
    const positioned: PositionedProgram[] = programs.map((p) => {
      const startMin = Math.max(0, this.minutesFromStart(new Date(p.startsAt)));
      const endMin = Math.min(totalMinutes, this.minutesFromStart(new Date(p.endsAt)));
      const width = Math.max(24, (endMin - startMin) * PX_PER_MINUTE);
      return { ...p, left: `${startMin * PX_PER_MINUTE}px`, width: `${width}px` };
    });
    return { channel, programs: positioned };
  }

  openSheet(channel: LiveChannel, program: LiveProgram): void {
    this.selectedSheet.set({ channel, program });
    this.sheetDialog()?.nativeElement.showModal();
  }

  closeSheet(): void {
    this.sheetDialog()?.nativeElement.close();
  }

  watchFromSheet(): void {
    const sheet = this.selectedSheet();
    if (!sheet) return;
    this.closeSheet();
    void this.router.navigate(['/watch-live', sheet.channel.id]);
  }

  episodeLabel(program: LiveProgram): string {
    if (program.seasonNumber == null || program.episodeNumber == null) return '';
    const s = String(program.seasonNumber).padStart(2, '0');
    const e = String(program.episodeNumber).padStart(2, '0');
    return `S${s}E${e}`;
  }
}
