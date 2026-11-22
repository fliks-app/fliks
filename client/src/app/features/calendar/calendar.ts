import {
  Component,
  signal,
  inject,
  OnInit,
  computed,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { NgClass } from '@angular/common';
import { TranslatePipe } from '@ngx-translate/core';
import { MediaService, CalendarEntry } from '../../core/services/api/media.service';
import { LocaleDatePipe } from '../../core/pipes/locale-date.pipe';
import { mediaDetailLink, kindOf } from '../../core/media-kinds';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { MD_BREAKPOINT_QUERY, mediaQuerySignal } from '../../core/utils/viewport';
import { CachedSrcDirective } from '../../shared/directives/cached-src.directive';

export type CalendarView = 'month' | 'agenda';
export type CalendarScope = 'all' | 'monitored' | 'mine';
export type EntryState = 'ok' | 'miss' | 'up';

const AGENDA_WEEKS = 6;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

interface CalendarWeek {
  days: CalendarDay[];
}

interface AgendaDay {
  dateStr: string;
  isToday: boolean;
  isTomorrow: boolean;
  entries: CalendarEntry[];
}

interface CalendarDay {
  date: Date;
  dateStr: string;
  isToday: boolean;
  isCurrentMonth: boolean;
  entries: CalendarEntry[];
}

@Component({
  selector: 'app-calendar',
  imports: [RouterLink, TranslatePipe, NgClass, LocaleDatePipe, ResolveUrlPipe, CachedSrcDirective],
  templateUrl: './calendar.html',
})
export class CalendarComponent implements OnInit {
  private readonly mediaService = inject(MediaService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly isMd = mediaQuerySignal(MD_BREAKPOINT_QUERY);
  private loadSeq = 0;
  readonly view = signal<CalendarView>(this.initialView());
  readonly scope = signal<CalendarScope>(this.initialScope());
  readonly agendaPages = signal(1);
  readonly currentDate = signal(this.initialMonth());
  /** Monday-first like the grid; 2024-01-01 is a Monday. */
  readonly weekdayReference = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i));
  readonly entries = signal<CalendarEntry[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');

  readonly showCinema = signal(this.loadFilter('cinema'));
  readonly showDigital = signal(this.loadFilter('digital'));
  readonly showPhysical = signal(this.loadFilter('physical'));
  readonly showAiring = signal(this.loadFilter('airing'));
  readonly showRelease = signal(this.loadFilter('release'));
  readonly filteredEntries = computed(() => {
    let result = this.entries();
    if (!this.showCinema()) result = result.filter((e) => e.event !== 'cinema');
    if (!this.showDigital()) result = result.filter((e) => e.event !== 'digital');
    if (!this.showPhysical()) result = result.filter((e) => e.event !== 'physical');
    if (!this.showAiring()) result = result.filter((e) => e.event !== 'airing');
    if (!this.showRelease()) result = result.filter((e) => e.event !== 'release');
    return result;
  });

  readonly weeks = computed<CalendarWeek[]>(() => {
    const now = this.currentDate();
    const today = new Date();
    const todayStr = this.toDateStr(today);
    const year = now.getFullYear();
    const month = now.getMonth();

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);

    // Start on Monday
    const startOffset = (firstDay.getDay() + 6) % 7;
    const start = new Date(firstDay);
    start.setDate(start.getDate() - startOffset);

    const entriesByDate = new Map<string, CalendarEntry[]>();
    for (const entry of this.filteredEntries()) {
      const key = entry.date.substring(0, 10);
      if (!entriesByDate.has(key)) entriesByDate.set(key, []);
      entriesByDate.get(key)!.push(entry);
    }

    const weeks: CalendarWeek[] = [];
    let current = new Date(start);

    while (current <= lastDay || weeks.length < 5) {
      const week: CalendarDay[] = [];
      for (let d = 0; d < 7; d++) {
        const dateStr = this.toDateStr(current);
        week.push({
          date: new Date(current),
          dateStr,
          isToday: dateStr === todayStr,
          isCurrentMonth: current.getMonth() === month,
          entries: entriesByDate.get(dateStr) ?? [],
        });
        current = new Date(current);
        current.setDate(current.getDate() + 1);
      }
      weeks.push({ days: week });
      if (current > lastDay && weeks.length >= 4) break;
    }

    return weeks;
  });

  readonly agendaDays = computed<AgendaDay[]>(() => {
    const today = this.toDateStr(new Date());
    const tomorrow = this.toDateStr(new Date(Date.now() + 86_400_000));
    const byDay = new Map<string, CalendarEntry[]>();
    for (const e of this.filteredEntries()) {
      const key = e.date.substring(0, 10);
      if (key < today) continue;
      const list = byDay.get(key);
      if (list) list.push(e);
      else byDay.set(key, [e]);
    }
    return [...byDay.keys()]
      .sort()
      .map((dateStr) => ({
        dateStr,
        isToday: dateStr === today,
        isTomorrow: dateStr === tomorrow,
        entries: byDay.get(dateStr)!,
      }));
  });

  ngOnInit() {
    void this.load();
  }

  setView(view: CalendarView) {
    this.view.set(view);
    this.store('calendar_view', view);
    this.syncUrl();
    void this.load();
  }

  setScope(value: string) {
    const scope: CalendarScope = value === 'monitored' || value === 'mine' ? value : 'all';
    this.scope.set(scope);
    this.store('calendar_scope', scope);
    void this.load();
  }

  prevMonth() {
    this.shiftMonth(-1);
  }

  nextMonth() {
    this.shiftMonth(1);
  }

  goToday() {
    const now = new Date();
    this.currentDate.set(new Date(now.getFullYear(), now.getMonth(), 1));
    this.agendaPages.set(1);
    this.syncUrl();
    void this.load();
  }

  loadMore() {
    this.agendaPages.update((n) => n + 1);
    void this.load();
  }

  private shiftMonth(delta: number) {
    this.currentDate.update((d) => new Date(d.getFullYear(), d.getMonth() + delta, 1));
    this.syncUrl();
    void this.load();
  }

  private syncUrl() {
    const d = this.currentDate();
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { view: this.view(), month },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  private initialView(): CalendarView {
    const q = this.route.snapshot?.queryParamMap?.get('view');
    if (q === 'month' || q === 'agenda') return q;
    const saved = this.read('calendar_view');
    if (saved === 'month' || saved === 'agenda') return saved;
    return this.isMd() ? 'month' : 'agenda';
  }

  private initialScope(): CalendarScope {
    const saved = this.read('calendar_scope');
    return saved === 'monitored' || saved === 'mine' ? saved : 'all';
  }

  private initialMonth(): Date {
    const m = MONTH_RE.exec(this.route.snapshot?.queryParamMap?.get('month') ?? '');
    const now = new Date();
    return m ? new Date(+m[1], +m[2] - 1, 1) : new Date(now.getFullYear(), now.getMonth(), 1);
  }

  private read(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private store(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch { /* storage unavailable */ }
  }

  private window(): [string, string] {
    if (this.view() === 'agenda') {
      const start = new Date();
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7 * AGENDA_WEEKS * this.agendaPages());
      return [this.toDateStr(start), this.toDateStr(end)];
    }
    const d = this.currentDate();
    return [
      this.toDateStr(new Date(d.getFullYear(), d.getMonth(), 1 - 7)),
      this.toDateStr(new Date(d.getFullYear(), d.getMonth() + 1, 7)),
    ];
  }

  private async load() {
    const [startStr, endStr] = this.window();
    const monitored = this.scope() === 'monitored';
    const mine = this.scope() === 'mine';
    const seq = ++this.loadSeq;
    this.loading.set(true);
    this.error.set('');
    try {
      const data = await this.mediaService.getCalendar(startStr, endStr, monitored, mine);
      if (seq === this.loadSeq) this.entries.set(data);
    } catch {
      if (seq === this.loadSeq) this.error.set('calendar.load_error');
    } finally {
      if (seq === this.loadSeq) this.loading.set(false);
    }
    queueMicrotask(() => {
      void this.mediaService
        .getCalendar(startStr, endStr, monitored, mine, { force: true })
        .then((fresh) => {
          if (seq === this.loadSeq) this.entries.set(fresh);
        })
        .catch(() => { /* keep cached entries */ });
    });
  }

  readonly states: EntryState[] = ['ok', 'miss', 'up'];

  stateDot(s: EntryState): string {
    return s === 'ok' ? 'bg-success' : s === 'miss' ? 'bg-error' : 'bg-base-content/40';
  }

  entryState(e: CalendarEntry): EntryState {
    if (e.hasFile) return 'ok';
    return e.date.substring(0, 10) < this.toDateStr(new Date()) ? 'miss' : 'up';
  }

  entrySub(e: CalendarEntry): string {
    if (!kindOf(e.type).hasSeasons) return '';
    const ep = `S${String(e.seasonNumber ?? 0).padStart(2, '0')}E${String(e.episodeNumber ?? 0).padStart(2, '0')}`;
    return e.episodeTitle ? `${ep} · ${e.episodeTitle}` : ep;
  }

  hasEpisode(e: CalendarEntry): boolean {
    return kindOf(e.type).hasSeasons;
  }

  private toDateStr(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  routeForEntry(e: CalendarEntry): string[] {
    return mediaDetailLink(e.type, e.mediaId);
  }

  entryLabel(e: CalendarEntry): string {
    if (!kindOf(e.type).hasSeasons) return e.title;
    const ep = `S${String(e.seasonNumber ?? 0).padStart(2, '0')}E${String(e.episodeNumber ?? 0).padStart(2, '0')}`;
    const epTitle = e.episodeTitle ? ` - ${e.episodeTitle}` : '';
    return `${e.title} ${ep}${epTitle}`;
  }

  toggleFilter(event: string) {
    const signalMap: Record<string, ReturnType<typeof signal<boolean>>> = {
      cinema: this.showCinema,
      digital: this.showDigital,
      physical: this.showPhysical,
      airing: this.showAiring,
      release: this.showRelease,
    };
    const s = signalMap[event];
    if (s) {
      s.update((v) => !v);
      this.saveFilter(event, s());
    }
  }

  isFilterActive(event: string): boolean {
    switch (event) {
      case 'cinema': return this.showCinema();
      case 'digital': return this.showDigital();
      case 'physical': return this.showPhysical();
      case 'airing': return this.showAiring();
      case 'release': return this.showRelease();
      default: return true;
    }
  }

  private loadFilter(event: string): boolean {
    const val = this.read(`calendar_filter_${event}`);
    return val === null ? true : val === '1';
  }

  private saveFilter(event: string, active: boolean) {
    this.store(`calendar_filter_${event}`, active ? '1' : '0');
  }

  eventClass(e: CalendarEntry): string {
    switch (e.event) {
      case 'cinema': return 'bg-primary/15 text-primary';
      case 'digital': return 'bg-info/15 text-info';
      case 'physical': return 'bg-warning/15 text-warning';
      case 'airing': return 'bg-secondary/15 text-secondary';
      default: return 'bg-primary/15 text-primary';
    }
  }
}
